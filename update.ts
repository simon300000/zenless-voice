import { basename, join, relative, sep } from 'path'
import { readFile, writeFile, readdir } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'

import { fnv1 } from './hoyo-voice-extractor/fnvjs/src/index.js'
import { copyReadme, findWAV, readJSON, updateStats } from './hoyo-voice-extractor/index.js'
import { galGameLinksFromBlocks } from './galgame-perform.js'

const RESULT_PATH = process.env.VOICE_RESULT_PATH || join(import.meta.dirname, 'result')
const WAV_PATH = join(RESULT_PATH, 'wav')
const DATA_PATH = join(import.meta.dirname, 'ZenlessData')
const execFileAsync = promisify(execFile)

const gameVersion = await (async () => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', DATA_PATH, 'log', '-1', '--format=%s'])
    return stdout.match(/(?:Win|REL)(\d+\.\d+\.\d+)/)?.[1] || ''
  } catch {
    return ''
  }
})()
const HASH_MATCHES_PATH = process.env.VOICE_HASH_MATCHES_PATH || join(import.meta.dirname, 'hash-matches.tsv')
const EVENT_WAVS_PATH = join(import.meta.dirname, 'event-wavs.tsv')
const GALGAME_PERFORM_PATH = process.env.VOICE_GALGAME_PERFORM_PATH || join(import.meta.dirname, 'StreamingAssets', 'GalGamePerform')
const GALGAME_EVIDENCE_PATH = process.env.VOICE_GALGAME_EVIDENCE || join(RESULT_PATH, 'galgame-text-evidence.jsonl')

const LANGUAGE_CONFIG: readonly { roots: readonly string[], name: string, maps: readonly string[] }[] = [
  { roots: ['cn'], name: 'Chinese', maps: ['TextMapTemplateTb.json', 'TextMapOverwriteTemplateTb.json'] },
  { roots: ['en'], name: 'English', maps: ['TextMap_ENTemplateTb.json', 'TextMap_ENOverwriteTemplateTb.json'] },
  { roots: ['jp'], name: 'Japanese', maps: ['TextMap_JATemplateTb.json', 'TextMap_JAOverwriteTemplateTb.json'] },
  { roots: ['kr'], name: 'Korean', maps: ['TextMap_KOTemplateTb.json', 'TextMap_KOOverwriteTemplateTb.json'] }
] as const

type Voice = {
  filename: string
  inGameFilename: string
  language: string
  transcription: string
  speaker: string
  voiceType: string
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

// FNV-1 32-bit of an event name is the canonical join key shared by every peer
// artifact.  Event names are lower-cased before hashing to match Wwise.
const eventHash32 = (name: string) => String(Number(fnv1(name.toLowerCase(), 32)) >>> 0)

const readMap = async (names: readonly string[]) => Object.assign({}, ...await Promise.all(names.map(async name => {
  try { return await readJSON<Record<string, string>>(join(DATA_PATH, 'TextMap', name)) }
  catch { return {} }
})))
console.log('Reading ZenlessData/TextMap...')
const textMaps: Record<string, Record<string, string>> = {}
for (const config of LANGUAGE_CONFIG) textMaps[config.name] = await readMap(config.maps)
const textKeys = new Set(Object.values(textMaps).flatMap(map => Object.keys(map)))
console.log(LANGUAGE_CONFIG.map(config => `${Object.keys(textMaps[config.name]).length} ${config.name}`).join(', ') + ' TextMap entries loaded')

const transcriptFor = (language: string, textId: string) => {
  const raw = textMaps[language]?.[textId]
  return typeof raw === 'string' ? raw : ''
}

const asArray = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)]

console.log('Building indexes directly from ZenlessData...')

const aliasToName: Record<string, string> = {}
const avatarBase = await readJSON<Json>(join(DATA_PATH, 'FileCfg', 'AvatarBaseTemplateTb.json'))
const indexAvatarAliases = (value: Json): void => {
  if (Array.isArray(value)) return value.forEach(indexAvatarAliases)
  if (!value || typeof value !== 'object') return
  const strings = Object.values(value).filter((entry): entry is string => typeof entry === 'string')
  for (const banks of strings) {
    for (const match of banks.matchAll(/(?:^|\|)BK_([A-Za-z0-9]+)_VO(?:\||$)/g)) {
      const alias = match[1]
      const display = strings.find(candidate => candidate.toLowerCase() === alias.toLowerCase()) ?? alias
      aliasToName[alias] = display
      aliasToName[alias.toLowerCase()] = display
    }
  }
  Object.values(value).forEach(indexAvatarAliases)
}
indexAvatarAliases(avatarBase)

type SourceInfo = { textID?: Json, speaker?: Json }
const sourceToText: Record<string, SourceInfo> = {}
const eventToText: Record<string, Json> = {}
const eventToVoiceType: Record<string, string> = {}
const sourcePattern = /^(?:VO_[A-Za-z0-9_./-]+|(?:Accompany|Activity|Breath|Bubble|Chat|ChatPlus|Chessboard|Cinema|Clue|Comic|Gal|GalGame|Level|Maincity|Message|NPC|Ongoing|OngoingAntique|OngoingCinema|OngoingLevel|OngoingMainCity|Timeline|Tips|TL|VoiceOnly)_[A-Za-z0-9_./-]+)$/
const sourceTables = [
  'OngoingTipsConfigTemplateTb.json',
  'TipsConfigTemplateTb.json',
  'SubtitleConfigTemplateTb.json',
  'ClueConfigTemplateTb.json',
  'MessageConfigTemplateTb.json'
]
const addSourceInfo = (source: string, ids: string[]) => {
  const previous = sourceToText[source]
  const existing = Array.isArray(previous?.textID) ? previous.textID.map(String) : previous?.textID == null ? [] : [String(previous.textID)]
  const merged = new Set([...existing, ...ids])
  sourceToText[source] = { textID: [...merged] }
}
const addEventText = (event: string, ids: string[]) => {
  const previous = eventToText[event]
  const previousIds = previous && typeof previous === 'object' && !Array.isArray(previous)
    ? asArray((previous as Record<string, Json>).textID)
    : []
  eventToText[event] = { textID: [...new Set([...previousIds, ...ids])] }
}
const indexConfigRows = (value: Json): void => {
  if (Array.isArray(value)) return value.forEach(indexConfigRows)
  if (!value || typeof value !== 'object') return
  const strings = Object.values(value).filter((entry): entry is string => typeof entry === 'string')
  const sources = strings.filter(source => sourcePattern.test(source) && !source.endsWith('/'))
  const ids = strings.filter(id => textKeys.has(id))
  if (sources.length && ids.length) for (const source of sources) addSourceInfo(source, ids)
  const events = strings.filter(name => /(Play|Stop|Set|Post)_V[Oo]/.test(name))
  if (events.length && ids.length) for (const event of events) addEventText(eventHash32(event), ids)
  for (const event of events) eventToVoiceType[eventHash32(event)] = /(?:Play|Stop|Set|Post)_V[Oo](?:_External)?_([A-Za-z0-9]+)/.exec(event)?.[1] ?? ''
  Object.values(value).forEach(indexConfigRows)
}
for (const table of sourceTables) indexConfigRows(await readJSON<Json>(join(DATA_PATH, 'FileCfg', table)))

const audioResource = await readJSON<{ tagedEvents?: number[], tags?: string[] }>(join(DATA_PATH, 'Data', 'JsonBytes', 'Audio', 'AudioResourceData.json'))
const voiceData = await readJSON<{ allPrefixes?: unknown }>(join(DATA_PATH, 'Data', '_unsorted', 'VoiceData.json'))
type GalGamePrefix = { path: string, speaker: string }
const galGamePrefixesBySpeaker = new Map<string, GalGamePrefix[]>()
if (Array.isArray(voiceData.allPrefixes)) {
  for (const value of voiceData.allPrefixes) {
    if (typeof value !== 'string') continue
    const match = /^VO_Galgame\/(?:[A-Za-z0-9_.-]+\/)*VO_([A-Za-z0-9]+)\/$/i.exec(value)
    if (!match) continue
    const speaker = match[1]
    const key = speaker.toLowerCase()
    const prefixes = galGamePrefixesBySpeaker.get(key) ?? []
    if (!prefixes.some(prefix => prefix.path.toLowerCase() === value.toLowerCase())) prefixes.push({ path: value, speaker })
    galGamePrefixesBySpeaker.set(key, prefixes)
  }
}
const speakerEventToSpeaker: Record<string, string> = {}
for (let index = 0; index < (audioResource.tagedEvents?.length ?? 0);) {
  const event = audioResource.tagedEvents![index++]
  const speakers = new Set<string>()
  while (index < audioResource.tagedEvents!.length && audioResource.tagedEvents![index] !== 0) {
    const tag = audioResource.tags?.[audioResource.tagedEvents![index++] - 1] ?? ''
    const speaker = aliasToName[tag] ?? aliasToName[tag.toLowerCase()]
    if (speaker) speakers.add(speaker)
  }
  index++
  if (speakers.size === 1) speakerEventToSpeaker[String(event)] = [...speakers][0]
}
const configEventToSpeaker = speakerEventToSpeaker
const pathToText: Record<string, Json> = sourceToText
const pathToSpeaker: Record<string, string> = {}
const pckWavToEvent: Record<string, string> = {}
const pckWavToPath: Record<string, string> = {}
const pckWavToText: Record<string, string> = {}
const bnkEventToWavs: Record<string, string[]> = {}
try {
  for (const row of (await readFile(EVENT_WAVS_PATH, 'utf8')).split('\n')) {
    if (!row) continue
    const [event, wav] = row.split('\t')
    if (event && wav) (bnkEventToWavs[event] ??= []).push(wav)
  }
} catch { /* the cracker writes this index when BNKs are available */ }
console.log(`ZenlessData indexes built: ${Object.keys(sourceToText).length} voice sources, ${Object.keys(bnkEventToWavs).length} BNK events, ${Object.keys(aliasToName).length} speaker aliases`)

// Exact filename preimages produced by the native hash cracker. The cracker
// reads only ZenlessData + extracted WAV hashes; update.ts independently
// resolves its TextMap id so neither transcript text nor a third-party mapping
// can enter metadata through this file.
type CrackedFilename = { speaker: string, source: string, sourceKey: string }
const crackedFilenames = new Map<string, CrackedFilename>()
const ambiguousCrackedHashes = new Set<string>()
console.log('Reading hash-matches.tsv...')
try {
  const rows = (await readFile(HASH_MATCHES_PATH, 'utf8')).split('\n')
  for (const row of rows) {
    if (!row) continue
    const columns = row.split('\t')
    // Current format: hash, speaker, source, sourceKey. Accept the former
    // five-column format as input too, but deliberately discard its inferred
    // textId: a filename hash proves the source preimage, not a TextMap join.
    const [hex, speaker, source, sourceKey] = columns.length >= 5
      ? [columns[0], columns[2], columns[3], columns[4]]
      : columns
    if (!/^[0-9a-f]{16}$/.test(hex) || !source) continue
    const candidate = { speaker: speaker ?? '', source, sourceKey: sourceKey ?? '' }
    const previous = crackedFilenames.get(hex)
    if (previous && previous.source.toLowerCase() === candidate.source.toLowerCase()) {
      previous.speaker ||= candidate.speaker
      previous.sourceKey ||= candidate.sourceKey
    } else if (previous) {
      ambiguousCrackedHashes.add(hex)
      crackedFilenames.delete(hex)
    } else if (!ambiguousCrackedHashes.has(hex)) {
      crackedFilenames.set(hex, candidate)
    }
  }
} catch { /* npm run update invokes the cracker first; direct node use may omit it */ }
console.log(`${crackedFilenames.size} unambiguous wav filenames loaded from the ZenlessData hash cracker${ambiguousCrackedHashes.size ? ` (${ambiguousCrackedHashes.size} ambiguous rejected)` : ''}`)

// GalScript dialogue nodes directly pair the scene-wide dialogueKey with the
// exact Wwise externalVoiceKey/voiceKey. This authoritative join avoids trying
// to derive a global dialogue ordinal from each speaker's local filename
// ordinal. Reviewed ASR evidence remains only as an optional fallback for
// sources absent from the extracted Perform index. Localized text always comes
// from the game TextMap, never from ASR output.
const galGameSourcePattern = /(?:^|\/)GalGame_([A-Za-z0-9-]+)_([A-Za-z0-9]+)_(\d+)(?:_(\d+))?$/i
const galGameTextPattern = /^(?:[A-Za-z0-9]+_)*GalGame_([A-Za-z0-9-]+)_(\d+)_(\d+)$/i
const galGameSourceKey = (source: string) => basename(source).toLowerCase()
const canonicalGalGameFamily = (family: string) => {
  const numericChapter = /^chapter0*(\d+)$/i.exec(family)
  return numericChapter ? `chapter${Number(numericChapter[1])}` : family.toLowerCase()
}
const compatibleGalGameEvidence = (source: string, textId: string) => {
  const sourceMatch = galGameSourcePattern.exec(source)
  const textMatch = galGameTextPattern.exec(textId)
  if (!sourceMatch || !textMatch || canonicalGalGameFamily(sourceMatch[1]) !== canonicalGalGameFamily(textMatch[1])) return false
  const sourceScene = String(Number(sourceMatch[3]))
  const textScene = String(Number(textMatch[2]))
  if (sourceMatch[3].length > 3) return sourceScene === textScene
  return sourceScene === String(Number(textMatch[2].slice(-sourceMatch[3].length)))
}
const galGameSourceToText = new Map<string, string>()
const officialGalGameSources = new Set<string>()
const ambiguousOfficialGalGameSources = new Set<string>()
type OfficialGalGameRecord = { source: string, sourceKey: string, textId: string }
const officialGalGameRecords: OfficialGalGameRecord[] = []
console.log('Reading official GalScript voice-to-TextMap index...')
try {
  const manifest = JSON.parse(await readFile(join(GALGAME_PERFORM_PATH, 'manifest.json'), 'utf8')) as { blocks?: unknown }
  if (!Array.isArray(manifest.blocks) || !manifest.blocks.every(block => typeof block === 'string')) throw new Error('invalid GalGame Perform manifest')
  const extracted = galGameLinksFromBlocks(await Promise.all(manifest.blocks.map(block => readFile(join(GALGAME_PERFORM_PATH, block)))))
  await writeFile(join(RESULT_PATH, 'galgame-perform-links.tsv'),
    '# GalScript voiceKey/externalVoiceKey\tdialogueKey\n' +
    [...extracted.links].sort(([left], [right]) => left.localeCompare(right)).map(([source, textId]) => `${extracted.sourceNames.get(source) ?? source}\t${textId}\n`).join(''))
  for (const [source, textId] of extracted.links) {
    const sourceName = extracted.sourceNames.get(source) ?? source
    officialGalGameRecords.push({ source: sourceName, sourceKey: galGameSourceKey(sourceName), textId })
    if (!textKeys.has(textId)) continue
    const key = galGameSourceKey(sourceName)
    const previous = galGameSourceToText.get(key)
    if (previous && previous !== textId) {
      galGameSourceToText.delete(key)
      officialGalGameSources.delete(key)
      ambiguousOfficialGalGameSources.add(key)
    } else if (!ambiguousOfficialGalGameSources.has(key)) {
      galGameSourceToText.set(key, textId)
      officialGalGameSources.add(key)
    }
  }
  console.log(`${extracted.mhyFiles} mhy1 bundles / ${extracted.cabFiles} CAB files scanned; ${extracted.directPairs} direct GalScript pairs found; ${extracted.fallbackLinks} legacy-format fallback links accepted${extracted.ambiguous ? `; ${extracted.ambiguous} ambiguous rejected during extraction` : ''}`)
} catch (error) {
  console.log(`GalGame Perform resources unavailable: ${error instanceof Error ? error.message : error}`)
}
console.log(`${officialGalGameSources.size} official GalScript links loaded${ambiguousOfficialGalGameSources.size ? `; ${ambiguousOfficialGalGameSources.size} ambiguous rejected` : ''}`)

const reviewedGalGameSources = new Set<string>()
const ambiguousReviewedGalGameSources = new Set<string>()
console.log('Reading reviewed GalGame TextMap evidence...')
try {
  for (const row of (await readFile(GALGAME_EVIDENCE_PATH, 'utf8')).split('\n')) {
    if (!row) continue
    let evidence: { source?: unknown, textId?: unknown, accepted?: unknown }
    try { evidence = JSON.parse(row) as typeof evidence } catch { continue }
    if (evidence.accepted !== true || typeof evidence.source !== 'string' || typeof evidence.textId !== 'string') continue
    if (!textKeys.has(evidence.textId) || !compatibleGalGameEvidence(evidence.source, evidence.textId)) continue
    const source = galGameSourceKey(evidence.source)
    if (officialGalGameSources.has(source) || ambiguousOfficialGalGameSources.has(source)) continue
    const previous = galGameSourceToText.get(source)
    if (previous && previous !== evidence.textId) {
      galGameSourceToText.delete(source)
      reviewedGalGameSources.delete(source)
      ambiguousReviewedGalGameSources.add(source)
    } else if (!ambiguousReviewedGalGameSources.has(source)) {
      galGameSourceToText.set(source, evidence.textId)
      reviewedGalGameSources.add(source)
    }
  }
} catch { /* evidence is optional; the structural join remains disabled without it */ }
console.log(`${reviewedGalGameSources.size} reviewed fallback links loaded${ambiguousReviewedGalGameSources.size ? `; ${ambiguousReviewedGalGameSources.size} ambiguous rejected` : ''}`)

// Resolve a raw speaker token (already a display name, or an internal alias) to
// its display name.  Never invents a name: an unmapped alias resolves to itself
// only when it already looks like a display name.
const resolveSpeaker = (raw: string | undefined) => {
  if (!raw) return ''
  return aliasToName[raw] ?? aliasToName[raw.toLowerCase()] ?? raw
}
// Authoritative event -> speaker: prefer speaker-folder, then config-text's
// event->speaker, then the NPC speaker carried alongside an event->text record.
const eventTextSpeaker = (event: string) => {
  const value = eventToText[event]
  return value && typeof value === 'object' && !Array.isArray(value) ? String((value as Record<string, Json>).speaker ?? '') : ''
}
const speakerForEvent = (event: string) => resolveSpeaker(speakerEventToSpeaker[event] ?? configEventToSpeaker[event] ?? eventTextSpeaker(event))

// A pathToText / nameToText value may be a textID string, an array of ids, or a
// { textID } object; collect every TextMap id it implies.
const textIdsOf = (value: Json): string[] => {
  if (value == null) return []
  if (Array.isArray(value)) return value.flatMap(textIdsOf)
  if (typeof value === 'object') return 'textID' in value ? textIdsOf((value as Record<string, Json>).textID) : []
  return [String(value)]
}
// Derive a speaker from a source path segment like ".../VO_Anbi/..." via the
// validated alias table; never invent a name when the alias is unmapped.
const speakerFromPath = (path: string) => {
  for (const segment of path.split('/')) {
    const alias = /^VO_([A-Za-z0-9]+)$/.exec(segment)?.[1]
    if (alias) { const name = aliasToName[alias] ?? aliasToName[alias.toLowerCase()]; if (name) return name }
  }
  return ''
}
const voiceTypeFromPath = (path: string) => /(?:^|\/)VO_([A-Za-z0-9]+)/.exec(path)?.[1] ?? ''

// Readable event names -> hash, for a human-friendly inGameFilename.  Only a few
// hundred event names live in configs; most events are known only by hash.
const eventNameByHash = new Map<string, string>()
console.log('Reading ZenlessData voice event names...')
{
  const record = (name: string) => { const h = eventHash32(name); if (!eventNameByHash.has(h)) eventNameByHash.set(h, name) }
  const collect = (value: Json) => {
    if (Array.isArray(value)) return value.forEach(collect)
    if (value && typeof value === 'object') return Object.values(value).forEach(collect)
    if (typeof value === 'string' && /(Play|Stop|Set|Post)_V[Oo]/.test(value) && value.length < 120 && !/[一-鿿]/.test(value)) record(value)
  }
  const walk = async (folder: string): Promise<void> => {
    let entries
    try { entries = await readdir(folder, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.json')) { try { collect(JSON.parse(await readFile(path, 'utf8'))) } catch { /* incomplete file */ } }
    }
  }
  await walk(join(DATA_PATH, 'FileCfg'))
  await walk(join(DATA_PATH, 'Data'))
}
console.log(`${eventNameByHash.size} readable voice event names indexed`)

// ---------------------------------------------------------------------------
// wav enumeration with CORRECT 64-bit id handling.
// The filename is 16 hex chars = the 64-bit PCK entry id (idHigh<<32 | idLow).
// The previous code used parseInt(name, 10) which silently corrupted every id.
// ---------------------------------------------------------------------------
const parseWavId = (name: string) => {
  const match = /^([0-9a-f]{16})$/i.exec(name)
  if (!match) return undefined
  const hex = match[1].toLowerCase()
  const id = BigInt('0x' + hex)
  return { hex, id, idHigh: Number(id >> 32n), idLow: Number(id & 0xffffffffn) }
}

console.log('Reading result/wav...')
const wavs = await findWAV(WAV_PATH)
const voiceMap: Record<string, Voice> = {}
const keysByHex = new Map<string, string[]>()
const languageOfPath = (key: string) => {
  for (const part of key.split('/')) {
    const root = part.toLowerCase()
    const config = LANGUAGE_CONFIG.find(config => config.roots.includes(root))
    if (config) return config.name
  }
  return ''
}
for (const filename of wavs) {
  const key = relative(WAV_PATH, filename).split(sep).join('/')
  const language = languageOfPath(key)
  voiceMap[key] = { filename, inGameFilename: '', language, transcription: '', speaker: '', voiceType: '' }
  const wid = parseWavId(basename(filename, '.wav'))
  if (wid) keysByHex.set(wid.hex, [...(keysByHex.get(wid.hex) || []), key])
}
console.log(`${Object.keys(voiceMap).length} wavs found (${keysByHex.size} distinct hex ids, ${Object.keys(voiceMap).length - [...keysByHex.values()].reduce((n, a) => n + a.length, 0)} decimal)`)

// GalScript supplies the exact voice leaf while VoiceData supplies every
// game-owned VO_Galgame prefix. Build only speaker-compatible full paths and
// use the external WAV's FNV-1 64 id as an exact verifier, never as a source of
// guessed filename components.
type GalScriptFilename = OfficialGalGameRecord & {
  speaker: string
  resolution: 'literal-full-path' | 'single-official-prefix' | 'unique-hash-match'
}
const FNV64_OFFSET_HIGH = 0xcbf29ce4
const FNV64_OFFSET_LOW = 0x84222325
const FNV64_LOW_PRIME = 0x1b3
const fnv1Hex64 = (value: string) => {
  let high = FNV64_OFFSET_HIGH
  let low = FNV64_OFFSET_LOW
  for (const byte of Buffer.from(value)) {
    const lowProduct = low * FNV64_LOW_PRIME
    high = (Math.imul(high, FNV64_LOW_PRIME) + Math.floor(lowProduct / 0x100000000) + ((low << 8) >>> 0)) >>> 0
    low = ((lowProduct >>> 0) ^ byte) >>> 0
  }
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0')
}
const languageTokens = new Map<string, Set<string>>()
for (const [key, voice] of Object.entries(voiceMap)) {
  const token = key.split('/').find(part => /^[A-Za-z]{2,}\([A-Za-z]+\)$/.test(part))?.toLowerCase()
  if (!token || !voice.language) continue
  const tokens = languageTokens.get(voice.language) ?? new Set<string>()
  tokens.add(token)
  languageTokens.set(voice.language, tokens)
}
const languageToken = new Map<string, string>()
for (const config of LANGUAGE_CONFIG) {
  const tokens = languageTokens.get(config.name) ?? new Set<string>()
  if (tokens.size === 1) languageToken.set(config.name, [...tokens][0])
  else console.log(`GalScript filename matching disabled for ${config.name}: expected one language token, found ${tokens.size}`)
}

const galScriptFilenames = new Map<string, GalScriptFilename>()
const ambiguousGalScriptHashes = new Set<string>()
let galScriptCandidatePaths = 0
let literalGalScriptSources = 0
let singlePrefixGalScriptSources = 0
const addGalScriptFilename = (hex: string, candidate: GalScriptFilename) => {
  const previous = galScriptFilenames.get(hex)
  if (previous && previous.source.toLowerCase() !== candidate.source.toLowerCase()) {
    galScriptFilenames.delete(hex)
    ambiguousGalScriptHashes.add(hex)
  } else if (!previous && !ambiguousGalScriptHashes.has(hex)) {
    galScriptFilenames.set(hex, candidate)
  }
}
for (const record of officialGalGameRecords) {
  const candidates = new Map<string, { source: string, speaker: string }>()
  if (record.source.includes('/')) {
    const folders = [...record.source.matchAll(/(?:^|\/)VO_([A-Za-z0-9]+)(?=\/)/g)]
    const speaker = folders.at(-1)?.[1] ?? ''
    candidates.set(record.source.toLowerCase(), { source: record.source, speaker })
    literalGalScriptSources++
  } else {
    const speakerKeys = new Set(record.sourceKey.split('_').filter(token => galGamePrefixesBySpeaker.has(token.toLowerCase())).map(token => token.toLowerCase()))
    for (const speakerKey of speakerKeys) {
      for (const prefix of galGamePrefixesBySpeaker.get(speakerKey) ?? []) {
        const source = prefix.path + record.source
        candidates.set(source.toLowerCase(), { source, speaker: prefix.speaker })
      }
    }
    if (candidates.size === 1) singlePrefixGalScriptSources++
  }
  galScriptCandidatePaths += candidates.size
  const resolution = record.source.includes('/')
    ? 'literal-full-path'
    : candidates.size === 1 ? 'single-official-prefix' : 'unique-hash-match'
  for (const candidate of candidates.values()) {
    for (const config of LANGUAGE_CONFIG) {
      const token = languageToken.get(config.name)
      if (!token) continue
      const hex = fnv1Hex64(`${token}/ex/${candidate.source}.wem`.toLowerCase())
      const targetKeys = keysByHex.get(hex)
      if (!targetKeys?.some(key => voiceMap[key]?.language === config.name)) continue
      addGalScriptFilename(hex, { ...record, ...candidate, resolution })
    }
  }
}

const conflictingFilenameHashes = new Set<string>()
let galScriptCrackerAgreements = 0
let galScriptOnlyMatches = 0
for (const [hex, candidate] of galScriptFilenames) {
  const cracked = crackedFilenames.get(hex)
  if (!cracked) {
    galScriptOnlyMatches++
  } else if (cracked.source.toLowerCase() === candidate.source.toLowerCase()) {
    galScriptCrackerAgreements++
  } else {
    conflictingFilenameHashes.add(hex)
  }
}
for (const hex of conflictingFilenameHashes) galScriptFilenames.delete(hex)
await writeFile(join(RESULT_PATH, 'galgame-path-matches.tsv'),
  '# wavHash\tfullPath\tdialogueKey\tresolution\n' +
  [...galScriptFilenames].sort(([left], [right]) => left.localeCompare(right)).map(([hex, match]) => `${hex}\t${match.source}\t${match.textId}\t${match.resolution}\n`).join(''))
console.log(`${galScriptFilenames.size} WAV filenames resolved directly from ${officialGalGameRecords.length} GalScript links + ${[...galGamePrefixesBySpeaker.values()].reduce((count, prefixes) => count + prefixes.length, 0)} VoiceData prefixes`)
console.log(`  ${galScriptCandidatePaths} official full-path candidates (${literalGalScriptSources} literal sources, ${singlePrefixGalScriptSources} single-prefix sources)`)
console.log(`  ${galScriptCrackerAgreements} agree with cracker, ${galScriptOnlyMatches} newly resolved, ${conflictingFilenameHashes.size} conflicts rejected${ambiguousGalScriptHashes.size ? `, ${ambiguousGalScriptHashes.size} GalScript hash ambiguities rejected` : ''}`)

// A source's game-owned localized transcription: resolve its TextMap ids, drop speaker
// name / title ids (e.g. ClueName_*, GalNPC<Char>, Avatar_*) that are not spoken
// lines, and de-duplicate repeated segments.
const NAME_ID = /name|title|^GalNPC|^Avatar_/i
const sourceTranscript = (info: { textID?: Json }, language: string): string => {
  const seen = new Set<string>()
  const texts: string[] = []
  for (const id of textIdsOf(info.textID ?? null)) {
    if (!textKeys.has(id) || NAME_ID.test(id)) continue
    const text = transcriptFor(language, id)
    if (text && !seen.has(text)) { seen.add(text); texts.push(text) }
  }
  return texts.join(' ')
}
// Event tokens normalize to their FNV-1 32-bit hash (decimal) so a peer may hand
// us either an event name or a hash.
const asEventHash = (token: string) => /^\d+$/.test(token) ? token : eventHash32(token)

// wav -> candidate event hashes, from the two disjoint link methods:
//  - bnk-wwise.eventToWavs: keyed by RELATIVE PATH (the decimal/embedded population)
//  - pck-hash.wavToEvent:   keyed by hex16 (the external population; currently a dead end)
const eventsByKey = new Map<string, Set<string>>()
console.log('Indexing Wwise event-to-wav links...')
for (const [event, paths] of Object.entries(bnkEventToWavs)) {
  const hash = asEventHash(event)
  for (const path of asArray(paths)) {
    const key = path.split(sep).join('/')
    const set = eventsByKey.get(key) ?? new Set<string>()
    set.add(hash)
    eventsByKey.set(key, set)
  }
}
const eventsByHex = new Map<string, Set<string>>()
for (const [hex, event] of Object.entries(pckWavToEvent)) {
  const key = hex.toLowerCase()
  const set = eventsByHex.get(key) ?? new Set<string>()
  set.add(asEventHash(String(event)))
  eventsByHex.set(key, set)
}
console.log(`${eventsByKey.size} wav paths and ${eventsByHex.size} hex ids have event candidates`)

const hexOfKey = (key: string) => { const m = /^([0-9a-f]{16})$/i.exec(basename(key, '.wav')); return m ? m[1].toLowerCase() : undefined }
const voiceTypeFromName = (name?: string) => {
  if (!name) return ''
  const external = /Play_V[Oo]_External_([A-Za-z0-9]+)/.exec(name)
  if (external) return external[1]
  const generic = /Play_V[Oo]_([A-Za-z0-9]+)/.exec(name)
  return generic ? generic[1] : ''
}

let transcriptionMatched = 0
let speakerMatched = 0
let inGameFilenameMatched = 0

console.log('Matching metadata...')
for (const [key, voice] of Object.entries(voiceMap)) {
  const hex = hexOfKey(key)
  const pathConflict = hex ? conflictingFilenameHashes.has(hex) : false
  const galScript = hex && !pathConflict ? galScriptFilenames.get(hex) : undefined
  const cracked = hex && !pathConflict ? crackedFilenames.get(hex) : undefined
  const events = new Set<string>([...(eventsByKey.get(key) ?? []), ...(hex ? eventsByHex.get(hex) ?? [] : [])])
  const sourcePath = galScript?.source ?? cracked?.source ?? (hex ? pckWavToPath[hex] : undefined)

  // --- transcription: only when a single TextMap id is unambiguously implied ---
  // Chain B (direct GalScript or cracked source): an exact 64-bit filename
  // match to a source that co-occurs with TextMap ids in game config -> use it.
  const sourceKey = galScript?.sourceKey ?? cracked?.sourceKey
  const sourceInfo = sourceKey ? sourceToText[sourceKey] : undefined
  const crackedText = sourceInfo ? sourceTranscript(sourceInfo, voice.language) : ''
  const galGameTextId = sourcePath ? galGameSourceToText.get(galGameSourceKey(sourcePath)) : undefined
  const galGameText = galGameTextId ? transcriptFor(voice.language, galGameTextId) : ''
  const templateText = crackedText || galGameText || undefined
  const textCandidates = new Set<string>()
  if (hex && pckWavToText[hex]) textCandidates.add(String(pckWavToText[hex]))
  if (sourcePath) for (const id of textIdsOf(pathToText[sourcePath])) if (textKeys.has(id)) textCandidates.add(id)
  for (const event of events) for (const id of textIdsOf(eventToText[event])) if (textKeys.has(id)) textCandidates.add(id)
  const resolved = [...textCandidates].map(id => ({ id, text: transcriptFor(voice.language, id) })).filter(entry => entry.text)
  const uniqueTexts = new Set(resolved.map(entry => entry.text))
  const chosen = templateText ? { id: '', text: templateText } : uniqueTexts.size === 1 ? resolved[0] : undefined

  // --- speaker: event -> speaker (both chains), unambiguous only. No folder->speaker. ---
  const eventSpeakers = new Set([...events].map(speakerForEvent).filter(Boolean))
  const pathSpeaker = galScript
    ? resolveSpeaker(galScript.speaker)
    : cracked ? resolveSpeaker(cracked.speaker) : sourcePath ? (resolveSpeaker(pathToSpeaker[sourcePath]) || speakerFromPath(sourcePath)) : ''
  const speaker = pathSpeaker || (eventSpeakers.size === 1 ? [...eventSpeakers][0] : '')

  // --- readable in-game identifier: source path if known, else event name(s)/hash(es) ---
  const inGameFilename = sourcePath
    ?? [...events].map(event => eventNameByHash.get(event)).find(Boolean)
    ?? (events.size ? [...events].sort().join('|') : '')
  const voiceType = (sourcePath ? voiceTypeFromPath(sourcePath) : '')
    || voiceTypeFromName(inGameFilename)
    || ([...events].map(event => eventToVoiceType[event]).find(Boolean) ?? '')

  if (inGameFilename) { voice.inGameFilename = String(inGameFilename); inGameFilenameMatched++ }
  if (chosen) { voice.transcription = chosen.text; transcriptionMatched++ }
  if (speaker) { voice.speaker = speaker; speakerMatched++ }
  if (voiceType) voice.voiceType = voiceType
}
const voiceCount = Object.keys(voiceMap).length
const coverage = (matched: number) => `${matched}/${voiceCount} (${voiceCount ? Math.round(matched / voiceCount * 100) : 0}%)`
console.log('Metadata coverage:')
console.log(`  inGameFilename: ${coverage(inGameFilenameMatched)}`)
console.log(`  transcription: ${coverage(transcriptionMatched)}`)
console.log(`  speaker: ${coverage(speakerMatched)}`)

console.log('Writing result/metadata.jsonl...')
await writeFile(join(RESULT_PATH, 'metadata.jsonl'), `${Object.values(voiceMap).map(voice => JSON.stringify(voice)).join('\n')}\n`)
console.log('Writing result.json...')
await writeFile(join(import.meta.dirname, 'result.json'), JSON.stringify(voiceMap))
console.log('Updating README statistics...')
await updateStats(voiceMap, join(import.meta.dirname, 'README.md'))
if (gameVersion) {
  const readme = await readFile(join(import.meta.dirname, 'README.md'), 'utf-8')
  await writeFile(join(import.meta.dirname, 'README.md'), readme.replace(/Last update at `([^`]+)`(?:, game version `[^`]+`)?/, `Last update at \`$1\`, game version \`${gameVersion}\``))
}
console.log('Copying dataset README...')
const huggingfaceMetadata = `---
task_categories:
- audio-classification
- automatic-speech-recognition
- text-to-speech
language:
- zh
- en
- ja
- ko
pretty_name: Zenless Voice
tags:
- audio
- zenless-zone-zero
---`

await copyReadme(join(import.meta.dirname, 'README.md'), join(RESULT_PATH, 'README.md'), huggingfaceMetadata)
console.log('Done')
