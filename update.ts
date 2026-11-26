import { basename, join, relative, sep } from 'path'
import { readFile, writeFile, readdir } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'

import { fnv1 } from './hoyo-voice-extractor/fnvjs/src/index.js'
import { copyReadme, findWAV, readJSON, updateStats } from './hoyo-voice-extractor/index.js'
import { galGameLinksFromBlocks } from './galgame-perform.js'
import { loadNativeGameData, mergeVoiceTextMaps } from './native-game-data.js'

const RESULT_PATH = process.env.VOICE_RESULT_PATH || join(import.meta.dirname, 'result')
const WAV_PATH = process.env.VOICE_WAV_PATH || join(RESULT_PATH, 'wav')
const DATA_PATH = process.env.VOICE_DATA_PATH || join(import.meta.dirname, 'ZenlessData')
const execFileAsync = promisify(execFile)

const dataIdentity = await (async () => {
  try {
    const safeDataPath = DATA_PATH.split(sep).join('/')
    const { stdout } = await execFileAsync('git', ['-c', `safe.directory=${safeDataPath}`, '-C', DATA_PATH, 'log', '-1', '--format=%H%n%s'])
    const [commit, subject = ''] = stdout.trim().split(/\r?\n/)
    return { commit, subject, version: subject.match(/(?:Win|REL)(\d+\.\d+\.\d+)/)?.[1] || '',
      region: subject.startsWith('OSPROD') ? 'global' : 'unverified', dataRevision: subject.match(/_D(\d+)/)?.[1] || '' }
  } catch {
    return { commit: '', subject: '', version: '', region: 'unverified', dataRevision: '' }
  }
})()
const gameVersion = dataIdentity.version
const HASH_MATCHES_PATH = process.env.VOICE_HASH_MATCHES_PATH || join(import.meta.dirname, 'hash-matches.tsv')
const EVENT_WAVS_PATH = process.env.VOICE_EVENT_WAVS_PATH || join(import.meta.dirname, 'event-wavs.tsv')
const GALGAME_PERFORM_PATH = process.env.VOICE_GALGAME_PERFORM_PATH || join(import.meta.dirname, 'StreamingAssets', 'GalGamePerform')
const native = process.env.VOICE_GAME_DATA_PATH ? await loadNativeGameData(process.env.VOICE_GAME_DATA_PATH, gameVersion) : undefined
if (native && dataIdentity.region !== 'global') throw new Error('Native Global data requires a verified Global supplemental checkout')

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
const voiceEventPattern = /(?:Play|Stop|Set|Post)_vo/i
const voiceTypeFromEventName = (name?: string) => {
  if (!name) return ''
  const external = /(?:Play|Stop|Set|Post)_vo_external_([A-Za-z0-9]+)/i.exec(name)
  if (external) return external[1]
  const generic = /(?:Play|Stop|Set|Post)_vo_([A-Za-z0-9]+)/i.exec(name)
  return generic && !/^\d+$/.test(generic[1]) ? generic[1] : ''
}

const supplementalTextMapFiles = new Map<string, { path: string, bytes: number, sha256: string }>()
const readMap = async (names: readonly string[]) => Object.assign({}, ...await Promise.all(names.map(async name => {
  const path = join(DATA_PATH, 'TextMap', name)
  let bytes: Buffer
  try { bytes = await readFile(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  const value = JSON.parse(bytes.toString('utf8')) as Record<string, string>
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(text => typeof text !== 'string')) {
    throw new Error(`Invalid supplemental TextMap: ${path}`)
  }
  supplementalTextMapFiles.set(name, { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  return value
})))
console.log('Reading ZenlessData/TextMap...')
const textMaps: Record<string, Record<string, string>> = {}
const textMapLayerSelection: Record<string, unknown> = {}
for (const config of LANGUAGE_CONFIG) {
  const main = await readMap(config.maps.filter(name => !name.includes('Overwrite')))
  const overwrite = await readMap(config.maps.filter(name => name.includes('Overwrite')))
  const merged = mergeVoiceTextMaps(native?.textMapLayers[config.name] ?? {}, main, overwrite)
  textMaps[config.name] = merged.textMap
  textMapLayerSelection[config.name] = merged.provenance
}
const textKeys = new Set(Object.values(textMaps).flatMap(map => Object.keys(map)))
console.log(LANGUAGE_CONFIG.map(config => `${Object.keys(textMaps[config.name]).length} ${config.name}`).join(', ') + ' TextMap entries loaded')

const transcriptFor = (language: string, textId: string) => {
  const raw = textMaps[language]?.[textId]
  return typeof raw === 'string' && raw.trim() ? raw : ''
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
const speakerAliases = new Map<string, string>()
for (const [alias, speaker] of Object.entries(aliasToName)) speakerAliases.set(alias.toLowerCase(), speaker)

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
const indexConfigRows = (
  value: Json,
  nonTranscriptSourceFields: ReadonlySet<string> = new Set(),
  directSourceTextFields: Readonly<Record<string, string>> = {}
): void => {
  if (Array.isArray(value)) return value.forEach(entry => indexConfigRows(entry, nonTranscriptSourceFields, directSourceTextFields))
  if (!value || typeof value !== 'object') return
  const entries = Object.entries(value).filter(([field]) => !nonTranscriptSourceFields.has(field))
  const strings = entries.map(([, entry]) => entry).filter((entry): entry is string => typeof entry === 'string')
  for (const [sourceField, textField] of Object.entries(directSourceTextFields)) {
    const source = value[sourceField]
    const textId = value[textField]
    if (typeof source === 'string' && source && !source.endsWith('/') && typeof textId === 'string' && textKeys.has(textId)) {
      addSourceInfo(source, [textId])
    }
  }
  const directSourceFields = new Set(Object.keys(directSourceTextFields))
  const sources = entries
    .filter(([field]) => !directSourceFields.has(field))
    .map(([, entry]) => entry)
    .filter((source): source is string => typeof source === 'string' && sourcePattern.test(source) && !source.endsWith('/'))
  const ids = strings.filter(id => textKeys.has(id))
  if (sources.length && ids.length) for (const source of sources) addSourceInfo(source, ids)
  const events = strings.filter(name => voiceEventPattern.test(name))
  if (events.length && ids.length) for (const event of events) addEventText(eventHash32(event), ids)
  for (const event of events) eventToVoiceType[eventHash32(event)] = voiceTypeFromEventName(event)
  entries.forEach(([, entry]) => indexConfigRows(entry, nonTranscriptSourceFields, directSourceTextFields))
}
// Tips rows can pair a spoken source with optional reaction/effort sources. Only
// the primary source speaks the row's TextMap line; auxiliary sources are short
// non-verbal clips and must not inherit that transcription.
const nonTranscriptSourceFieldsByTable: Record<string, ReadonlySet<string>> = {
  'TipsConfigTemplateTb.json': new Set(['CGMNACEDDCC', 'AHJNODOLGNK']),
  'OngoingTipsConfigTemplateTb.json': new Set(['AGFNGIEPKMF', 'AHGPBIEOHNF'])
}
const directSourceTextFieldsByTable: Record<string, Readonly<Record<string, string>>> = {
  'OngoingTipsConfigTemplateTb.json': {
    DGFCDOGFFGP: 'PMNJCMFLJIL',
    EODLJIEIIGJ: 'PMNJCMFLJIL'
  },
  'TipsConfigTemplateTb.json': {
    BNJPOOIINPC: 'KIFPIHAAPOK',
    FNJFEHALLGF: 'KIFPIHAAPOK'
  }
}
for (const table of sourceTables) {
  indexConfigRows(
    await readJSON<Json>(join(DATA_PATH, 'FileCfg', table)),
    nonTranscriptSourceFieldsByTable[table],
    directSourceTextFieldsByTable[table]
  )
}
type SubtitleSegment = { time: number[], textId: string }
const subtitleSegments = new Map<string, Map<string, SubtitleSegment[]>>()
const indexSubtitleRows = (value: Json): void => {
  if (Array.isArray(value)) return value.forEach(indexSubtitleRows)
  if (!value || typeof value !== 'object') return
  const source = value.PMIKEPAJFKN
  const rawLanguage = value.APDFDBPICNM
  const textId = value.AFDMDFIHPMH
  const rawTime = value.INPHPLFPOKF
  const language = typeof rawLanguage === 'string'
    ? LANGUAGE_CONFIG.find(config => rawLanguage.toLowerCase().startsWith(`${config.name.toLowerCase()}(`))?.name
    : undefined
  const time = typeof rawTime === 'string' && /^\d+:\d+:\d+:\d+$/.test(rawTime)
    ? rawTime.split(':').map(Number)
    : []
  if (typeof source === 'string' && language && typeof textId === 'string' && textKeys.has(textId) && time.length === 4) {
    const byLanguage = subtitleSegments.get(source.toLowerCase()) ?? new Map<string, SubtitleSegment[]>()
    const segments = byLanguage.get(language) ?? []
    segments.push({ time, textId })
    byLanguage.set(language, segments)
    subtitleSegments.set(source.toLowerCase(), byLanguage)
  }
  Object.values(value).forEach(indexSubtitleRows)
}
indexSubtitleRows(await readJSON<Json>(join(DATA_PATH, 'FileCfg', 'SubtitleConfigTemplateTb.json')))
const clueTranscriptBySourceLanguage = new Map<string, string>()
for (const [source, byLanguage] of subtitleSegments) {
  if (!LANGUAGE_CONFIG.every(config => byLanguage.has(config.name))) continue
  let invalid = false
  const orderedByLanguage = new Map<string, SubtitleSegment[]>()
  for (const config of LANGUAGE_CONFIG) {
    const ordered = [...byLanguage.get(config.name)!].sort((left, right) => {
      for (let index = 0; index < 4; index++) if (left.time[index] !== right.time[index]) return left.time[index] - right.time[index]
      return left.textId.localeCompare(right.textId)
    })
    for (let index = 1; index < ordered.length; index++) {
      if (ordered[index].time.every((part, partIndex) => part === ordered[index - 1].time[partIndex]) && ordered[index].textId !== ordered[index - 1].textId) invalid = true
    }
    orderedByLanguage.set(config.name, ordered)
  }
  const signatures = new Set([...orderedByLanguage.values()].map(segments => segments.map(segment => segment.textId).join('\0')))
  if (invalid || signatures.size !== 1) continue
  for (const config of LANGUAGE_CONFIG) {
    const texts = orderedByLanguage.get(config.name)!.map(segment => transcriptFor(config.name, segment.textId))
    if (texts.some(text => !text)) { invalid = true; break }
    clueTranscriptBySourceLanguage.set(`${source}\0${config.name}`, texts.join('\n'))
  }
  if (invalid) for (const config of LANGUAGE_CONFIG) clueTranscriptBySourceLanguage.delete(`${source}\0${config.name}`)
}
console.log(`${clueTranscriptBySourceLanguage.size} segmented Clue transcripts built from SubtitleConfig`)
const configSpeakerBySourceLeaf = new Map<string, { textId: string, speaker: string }>()
const ambiguousConfigSpeakerLeaves = new Set<string>()
const addConfigSpeaker = (source: string, textId: string) => {
  const leaf = basename(source).toLowerCase()
  const speaker = transcriptFor('English', textId)
  if (!speaker || /\{[MF]#|^\?+$/i.test(speaker.trim())) {
    configSpeakerBySourceLeaf.delete(leaf)
    ambiguousConfigSpeakerLeaves.add(leaf)
    return
  }
  const previous = configSpeakerBySourceLeaf.get(leaf)
  if (previous && previous.textId !== textId) {
    configSpeakerBySourceLeaf.delete(leaf)
    ambiguousConfigSpeakerLeaves.add(leaf)
  } else if (!previous && !ambiguousConfigSpeakerLeaves.has(leaf)) {
    configSpeakerBySourceLeaf.set(leaf, { textId, speaker })
  }
}
const indexConfigSpeakers = (value: Json): void => {
  if (Array.isArray(value)) return value.forEach(indexConfigSpeakers)
  if (!value || typeof value !== 'object') return
  const speakerTextId = value.LKHLBFELGNI
  if (typeof speakerTextId === 'string' && textKeys.has(speakerTextId)) {
    for (const field of ['DGFCDOGFFGP', 'EODLJIEIIGJ']) {
      const source = value[field]
      if (typeof source === 'string' && source) addConfigSpeaker(source, speakerTextId)
    }
  }
  Object.values(value).forEach(indexConfigSpeakers)
}
indexConfigSpeakers(await readJSON<Json>(join(DATA_PATH, 'FileCfg', 'OngoingTipsConfigTemplateTb.json')))
console.log(`${configSpeakerBySourceLeaf.size} unique config source-speaker links built from OngoingTipsConfig`)
const sourceInfoByUniqueLeaf = new Map<string, SourceInfo>()
const sourceNameByUniqueLeaf = new Map<string, string>()
const ambiguousSourceLeaves = new Set<string>()
for (const [source, info] of Object.entries(sourceToText)) {
  const leaf = basename(source).toLowerCase()
  const previous = sourceNameByUniqueLeaf.get(leaf)
  if (previous && previous.toLowerCase() !== source.toLowerCase()) {
    sourceInfoByUniqueLeaf.delete(leaf)
    sourceNameByUniqueLeaf.delete(leaf)
    ambiguousSourceLeaves.add(leaf)
  } else if (!previous && !ambiguousSourceLeaves.has(leaf)) {
    sourceInfoByUniqueLeaf.set(leaf, info)
    sourceNameByUniqueLeaf.set(leaf, source)
  }
}

const audioResource = await readJSON<{ tagedEvents?: number[], tags?: string[], eventReferenceBanks?: number[] }>(join(DATA_PATH, 'Data', 'JsonBytes', 'Audio', 'AudioResourceData.json'))
const voiceData = await readJSON<{ allPrefixes?: unknown }>(join(DATA_PATH, 'Data', '_unsorted', 'VoiceData.json'))
type GalGamePrefix = { path: string, speaker: string }
const galGamePrefixesBySpeaker = new Map<string, GalGamePrefix[]>()
const officialVoicePrefixToSpeakers = new Map<string, Set<string>>()
if (Array.isArray(voiceData.allPrefixes)) {
  for (const value of voiceData.allPrefixes) {
    if (typeof value !== 'string') continue
    const parts = value.split('/').filter(Boolean)
    const speakerFolder = [...parts.slice(1)].reverse().find(part => /^VO_/i.test(part))
    if (speakerFolder) {
      const speakers = officialVoicePrefixToSpeakers.get(value.toLowerCase()) ?? new Set<string>()
      speakers.add(speakerFolder.slice(3))
      officialVoicePrefixToSpeakers.set(value.toLowerCase(), speakers)
    }
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
const referenceBanksByEvent = new Map<string, Set<string>>()
for (let index = 0; index < (audioResource.eventReferenceBanks?.length ?? 0);) {
  const event = String(audioResource.eventReferenceBanks![index++])
  const banks = new Set<string>()
  while (index < audioResource.eventReferenceBanks!.length && audioResource.eventReferenceBanks![index] !== 0) {
    banks.add(String(audioResource.eventReferenceBanks![index++]))
  }
  index++
  if (banks.size) referenceBanksByEvent.set(event, banks)
}
const configEventToSpeaker = speakerEventToSpeaker
const pathToText: Record<string, Json> = sourceToText
const pathToSpeaker: Record<string, string> = {}
const pckWavToEvent: Record<string, string> = {}
const pckWavToPath: Record<string, string> = {}
const pckWavToText: Record<string, string> = {}
const bnkEventToWavs: Record<string, string[]> = {}
const referencedBnkEventToWavs: Record<string, string[]> = {}
let unreferencedBnkEventRows = 0
try {
  for (const row of (await readFile(EVENT_WAVS_PATH, 'utf8')).split(/\r?\n/)) {
    if (!row) continue
    const [event, wav, bank] = row.split('\t')
    if (!event || !wav) continue
    if (!bank || !referenceBanksByEvent.get(event)?.has(bank)) {
      unreferencedBnkEventRows++
      continue
    }
    ;(bnkEventToWavs[event] ??= []).push(wav)
    ;(referencedBnkEventToWavs[event] ??= []).push(wav)
  }
} catch { /* the cracker writes this index when BNKs are available */ }
console.log(`ZenlessData indexes built: ${Object.keys(sourceToText).length} voice sources, ${Object.keys(bnkEventToWavs).length} game-declared BNK events, ${Object.keys(aliasToName).length} speaker aliases${unreferencedBnkEventRows ? `; ${unreferencedBnkEventRows} undeclared event-bank rows rejected` : ''}`)

// Exact filename preimages produced by the native hash cracker. The cracker
// reads only ZenlessData + extracted WAV hashes; update.ts independently
// resolves its TextMap id so neither transcript text nor a third-party mapping
// can enter metadata through this file.
type CrackedFilename = {
  speaker: string
  source: string
  sourceKey: string
  evidence: Set<string>
  speakerConflict: boolean
  sourceKeyConflict: boolean
}
const GAME_FILENAME_EVIDENCE = new Set([
  'game-source',
  'textmap-dialogue',
  'textmap-legacy',
  'textmap-local-scene',
  'textmap-chat',
  'textmap-timeline',
  'comic-asset'
])
const crackedFilenames = new Map<string, CrackedFilename>()
const ambiguousCrackedHashes = new Set<string>()
let unprovenancedCrackedRows = 0
console.log('Reading hash-matches.tsv...')
try {
  const rows = (await readFile(HASH_MATCHES_PATH, 'utf8')).split(/\r?\n/)
  for (const row of rows) {
    if (!row) continue
    const columns = row.split('\t')
    // Current format: hash, speaker, source, sourceKey, evidence. Rows without
    // an explicit game-only provenance are audit candidates, not metadata.
    const [hex, speaker, source, sourceKey, evidenceText] = columns
    if (!/^[0-9a-f]{16}$/.test(hex) || !source) continue
    const evidence = new Set((evidenceText ?? '').split(',').filter(Boolean))
    if (![...evidence].some(value => GAME_FILENAME_EVIDENCE.has(value))) {
      unprovenancedCrackedRows++
      continue
    }
    const candidate: CrackedFilename = {
      speaker: speaker ?? '',
      source,
      sourceKey: sourceKey ?? '',
      evidence,
      speakerConflict: evidence.has('speaker-conflict'),
      sourceKeyConflict: evidence.has('sourcekey-conflict')
    }
    const previous = crackedFilenames.get(hex)
    if (previous && previous.source.toLowerCase() === candidate.source.toLowerCase()) {
      for (const value of candidate.evidence) previous.evidence.add(value)
      if (!previous.speakerConflict && candidate.speaker) {
        if (!previous.speaker) previous.speaker = candidate.speaker
        else if (previous.speaker.toLowerCase() !== candidate.speaker.toLowerCase()) {
          previous.speaker = ''
          previous.speakerConflict = true
        }
      }
      if (!previous.sourceKeyConflict && candidate.sourceKey) {
        if (!previous.sourceKey) previous.sourceKey = candidate.sourceKey
        else if (previous.sourceKey.toLowerCase() !== candidate.sourceKey.toLowerCase()) {
          previous.sourceKey = ''
          previous.sourceKeyConflict = true
        }
      }
      previous.speakerConflict ||= candidate.speakerConflict
      previous.sourceKeyConflict ||= candidate.sourceKeyConflict
      if (previous.speakerConflict) previous.speaker = ''
      if (previous.sourceKeyConflict) previous.sourceKey = ''
    } else if (previous) {
      ambiguousCrackedHashes.add(hex)
      crackedFilenames.delete(hex)
    } else if (!ambiguousCrackedHashes.has(hex)) {
      crackedFilenames.set(hex, candidate)
    }
  }
} catch { /* npm run update invokes the cracker first; direct node use may omit it */ }
console.log(`${crackedFilenames.size} unambiguous game-provenanced wav filenames loaded from the ZenlessData hash cracker${ambiguousCrackedHashes.size ? ` (${ambiguousCrackedHashes.size} ambiguous rejected)` : ''}${unprovenancedCrackedRows ? `; ${unprovenancedCrackedRows} unprovenanced rows rejected` : ''}`)

// GalScript dialogue nodes directly pair the scene-wide dialogueKey with the
// exact Wwise externalVoiceKey/voiceKey. This authoritative game-file join
// avoids trying to derive a global dialogue ordinal from each speaker's local
// filename ordinal. Localized text comes only from the game TextMap.
const galGameSourceKey = (source: string) => basename(source).toLowerCase()
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
if (native) {
  for (const { source, textId } of native.links) {
    const key = galGameSourceKey(source)
    officialGalGameRecords.push({ source, sourceKey: key, textId })
    if (!textKeys.has(textId)) continue
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
  await writeFile(join(RESULT_PATH, 'native-game-data-provenance.json'), JSON.stringify({
    ...native.provenance, textMapLayerSelection, supplementalDataPath: DATA_PATH, supplementalDataIdentity: dataIdentity,
    supplementalTextMapFiles: [...supplementalTextMapFiles.values()]
  }, null, 2) + '\n')
  await writeFile(join(RESULT_PATH, 'native-dialogue-links.jsonl'), native.links.map(row => JSON.stringify(row)).join('\n') + '\n')
}
console.log(`${officialGalGameSources.size} official GalScript links loaded${ambiguousOfficialGalGameSources.size ? `; ${ambiguousOfficialGalGameSources.size} ambiguous rejected` : ''}`)

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
const templatedEventToSpeaker = new Map<string, string>()
const ambiguousTemplatedSpeakerEvents = new Set<string>()
const namedEventToSpeaker = new Map<string, string>()
const ambiguousNamedSpeakerEvents = new Set<string>()
const addEventSpeaker = (target: Map<string, string>, ambiguous: Set<string>, event: string, speaker: string) => {
  const previous = target.get(event)
  if (previous && previous !== speaker) {
    target.delete(event)
    ambiguous.add(event)
  } else if (!previous && !ambiguous.has(event)) {
    target.set(event, speaker)
  }
}
const speakerForEvent = (event: string, allowNameDerivedEvidence: boolean) => {
  const candidates: (string | undefined)[] = [
    speakerEventToSpeaker[event],
    configEventToSpeaker[event],
    eventTextSpeaker(event)
  ]
  if (allowNameDerivedEvidence) candidates.push(templatedEventToSpeaker.get(event), namedEventToSpeaker.get(event))
  const speakers = new Set(candidates.map(resolveSpeaker).filter(Boolean))
  return speakers.size === 1 ? [...speakers][0] : ''
}

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
const identifierTokens = (value: string) => value.toLowerCase().match(/[a-z0-9]+/g) ?? []
const containsTokenSequence = (tokens: string[], sequence: string[]) => sequence.length > 0 && tokens.some((_, start) =>
  sequence.every((token, offset) => tokens[start + offset] === token)
)
const speakerFromOfficialPrefix = (path: string) => {
  const parts = path.split('/')
  const leafTokens = identifierTokens(basename(path))
  const speakers = new Set<string>()
  for (let end = parts.length - 1; end > 0; end--) {
    const prefix = parts.slice(0, end).join('/').toLowerCase() + '/'
    for (const speaker of officialVoicePrefixToSpeakers.get(prefix) ?? []) {
      if (containsTokenSequence(leafTokens, identifierTokens(speaker))) speakers.add(resolveSpeaker(speaker))
    }
  }
  return speakers.size === 1 ? [...speakers][0] : ''
}
const voiceTypeFromPath = (path: string) => /(?:^|\/)VO_([A-Za-z0-9]+)/i.exec(path)?.[1] ?? ''

// Readable event names -> hash, for event-level speaker and voiceType evidence.
// Event evidence never proves a full external-source filename.
const eventNameByHash = new Map<string, string>()
const ambiguousEventNameHashes = new Set<string>()
console.log('Reading ZenlessData voice event names...')
{
  let literalEventNames = 0
  const eventTemplates = new Set<string>()
  const speakerFromEventName = (name: string) => {
    const speakers = new Set(name.split(/[^A-Za-z0-9]+/).map(token => speakerAliases.get(token.toLowerCase())).filter(Boolean) as string[])
    return speakers.size === 1 ? [...speakers][0] : ''
  }
  const record = (name: string, templatedSpeaker = '') => {
    const hash = eventHash32(name)
    const previous = eventNameByHash.get(hash)
    if (previous && previous.toLowerCase() !== name.toLowerCase()) {
      eventNameByHash.delete(hash)
      ambiguousEventNameHashes.add(hash)
    } else if (!previous && !ambiguousEventNameHashes.has(hash)) {
      eventNameByHash.set(hash, name)
    }
    if (templatedSpeaker) {
      addEventSpeaker(templatedEventToSpeaker, ambiguousTemplatedSpeakerEvents, hash, templatedSpeaker)
    } else {
      const namedSpeaker = speakerFromEventName(name)
      if (namedSpeaker) addEventSpeaker(namedEventToSpeaker, ambiguousNamedSpeakerEvents, hash, namedSpeaker)
    }
  }
  const collect = (value: Json) => {
    if (Array.isArray(value)) return value.forEach(collect)
    if (value && typeof value === 'object') return Object.values(value).forEach(collect)
    if (typeof value !== 'string' || !voiceEventPattern.test(value) || value.length >= 120 || /[一-鿿]/.test(value)) return
    if (value.includes('{}')) {
      eventTemplates.add(value)
      for (const [alias, speaker] of speakerAliases) record(value.replaceAll('{}', alias), speaker)
    } else {
      literalEventNames++
      record(value)
    }
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
  console.log(`${literalEventNames} literal voice event occurrences and ${eventTemplates.size} runtime templates scanned`)
}
console.log(`${eventNameByHash.size} readable/expanded voice event names indexed${ambiguousEventNameHashes.size ? `; ${ambiguousEventNameHashes.size} hash ambiguities rejected` : ''}`)
console.log(`${templatedEventToSpeaker.size} templated and ${namedEventToSpeaker.size} literal event speakers indexed${ambiguousTemplatedSpeakerEvents.size + ambiguousNamedSpeakerEvents.size ? `; ${ambiguousTemplatedSpeakerEvents.size + ambiguousNamedSpeakerEvents.size} speaker ambiguities rejected` : ''}`)

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
const wavs = (await findWAV(WAV_PATH)).sort((left, right) =>
  basename(left).localeCompare(basename(right)) || left.localeCompare(right)
)
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

// A source's game-owned localized transcription: resolve its TextMap ids, drop
// name/title ids, and accept only one TextMap id. Ambiguity stays blank even
// when two ids happen to localize to the same string in one language.
const NAME_ID = /name|title|^GalNPC|^Avatar_/i
const sourceTranscript = (info: { textID?: Json }, language: string): string => {
  const ids = new Set(textIdsOf(info.textID ?? null).filter(id => textKeys.has(id) && !NAME_ID.test(id)))
  if (ids.size !== 1) return ''
  return transcriptFor(language, [...ids][0])
}
// Event tokens normalize to their FNV-1 32-bit hash (decimal) so a peer may hand
// us either an event name or a hash.
const asEventHash = (token: string) => /^\d+$/.test(token) ? token : eventHash32(token)

// wav -> candidate event hashes, from the two disjoint link methods:
//  - bnk-wwise.eventToWavs: keyed by RELATIVE PATH (the decimal/embedded population)
//  - pck-hash.wavToEvent:   keyed by hex16 (the external population; currently a dead end)
const eventsByKey = new Map<string, Set<string>>()
const referencedEventsByKey = new Map<string, Set<string>>()
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
for (const [event, paths] of Object.entries(referencedBnkEventToWavs)) {
  const hash = asEventHash(event)
  for (const path of asArray(paths)) {
    const key = path.split(sep).join('/')
    const set = referencedEventsByKey.get(key) ?? new Set<string>()
    set.add(hash)
    referencedEventsByKey.set(key, set)
  }
}
const eventsByHex = new Map<string, Set<string>>()
for (const [hex, event] of Object.entries(pckWavToEvent)) {
  const key = hex.toLowerCase()
  const set = eventsByHex.get(key) ?? new Set<string>()
  set.add(asEventHash(String(event)))
  eventsByHex.set(key, set)
}
console.log(`${eventsByKey.size} wav paths and ${eventsByHex.size} hex ids have event candidates; ${referencedEventsByKey.size} paths have game-declared event-bank links`)

const hexOfKey = (key: string) => { const m = /^([0-9a-f]{16})$/i.exec(basename(key, '.wav')); return m ? m[1].toLowerCase() : undefined }
const confirmedSourceByLeaf = new Map<string, string>()
const ambiguousConfirmedSourceLeaves = new Set<string>()
for (const source of [...crackedFilenames.values(), ...galScriptFilenames.values()].map(candidate => candidate.source)) {
  const leaf = basename(source).toLowerCase()
  const previous = confirmedSourceByLeaf.get(leaf)
  if (previous && previous !== source.toLowerCase()) {
    confirmedSourceByLeaf.delete(leaf)
    ambiguousConfirmedSourceLeaves.add(leaf)
  } else if (!previous && !ambiguousConfirmedSourceLeaves.has(leaf)) {
    confirmedSourceByLeaf.set(leaf, source.toLowerCase())
  }
}

let transcriptionMatched = 0
let speakerMatched = 0
let inGameFilenameMatched = 0
let transcriptionConflicts = 0
let directGalScriptDisagreements = 0
let speakerConflicts = 0
let invalidCrackedFilenameEvidence = 0

console.log('Matching metadata...')
for (const [key, voice] of Object.entries(voiceMap)) {
  const hex = hexOfKey(key)
  const token = languageToken.get(voice.language)
  const pathConflict = hex ? conflictingFilenameHashes.has(hex) : false
  const galScript = hex && !pathConflict ? galScriptFilenames.get(hex) : undefined
  const indexedCracked = hex && !pathConflict ? crackedFilenames.get(hex) : undefined
  const cracked = indexedCracked && token && fnv1Hex64(`${token}/ex/${indexedCracked.source}.wem`.toLowerCase()) === hex
    ? indexedCracked
    : undefined
  if (indexedCracked && !cracked) invalidCrackedFilenameEvidence++
  const events = new Set<string>([...(eventsByKey.get(key) ?? []), ...(hex ? eventsByHex.get(hex) ?? [] : [])])
  const referencedEvents = referencedEventsByKey.get(key) ?? new Set<string>()
  const nativePath = hex ? native?.paths.get(`${voice.language}:${hex}`) : undefined
  const nativeSource = nativePath?.replace(/^[^/]+\/ex\//i, '').replace(/\.wem$/i, '')
  const sourcePath = nativeSource ?? galScript?.source ?? cracked?.source ?? (hex ? pckWavToPath[hex] : undefined)

  // --- transcription: only when a single TextMap id is unambiguously implied ---
  // Chain B (direct GalScript or cracked source): an exact 64-bit filename
  // match to a source that co-occurs with TextMap ids in game config -> use it.
  const sourceKey = galScript?.sourceKey ?? cracked?.sourceKey
  const sourceKeyConflict = !galScript && cracked?.sourceKeyConflict
  const sourceInfo = sourceKeyConflict ? undefined : sourceKey
    ? sourceToText[sourceKey]
    : sourcePath && !ambiguousConfirmedSourceLeaves.has(basename(sourcePath).toLowerCase())
      ? sourceInfoByUniqueLeaf.get(basename(sourcePath).toLowerCase())
      : undefined
  const crackedText = sourceInfo ? sourceTranscript(sourceInfo, voice.language) : ''
  const galGameTextId = sourcePath ? galGameSourceToText.get(galGameSourceKey(sourcePath)) : undefined
  const galGameText = galGameTextId ? transcriptFor(voice.language, galGameTextId) : ''
  const clueText = sourcePath ? clueTranscriptBySourceLanguage.get(`${sourcePath.toLowerCase()}\0${voice.language}`) ?? '' : ''
  const textCandidates = new Set<string>()
  if (hex && pckWavToText[hex]) textCandidates.add(String(pckWavToText[hex]))
  if (sourcePath) for (const id of textIdsOf(pathToText[sourcePath])) if (textKeys.has(id)) textCandidates.add(id)
  for (const event of events) if (referencedEvents.has(event)) {
    for (const id of textIdsOf(eventToText[event])) if (textKeys.has(id)) textCandidates.add(id)
  }
  const spokenTextIds = new Set([...textCandidates].filter(id => !NAME_ID.test(id)))
  const linkedText = spokenTextIds.size === 1 ? transcriptFor(voice.language, [...spokenTextIds][0]) : ''
  const secondaryTextEvidence = new Set([clueText, crackedText, linkedText].filter(Boolean))
  const textEvidence = new Set([galGameText, ...secondaryTextEvidence].filter(Boolean))
  const chosenText = galGameText || (secondaryTextEvidence.size === 1 ? [...secondaryTextEvidence][0] : '')
  if (galGameText && textEvidence.size > 1) directGalScriptDisagreements++
  else if (!galGameText && secondaryTextEvidence.size > 1) transcriptionConflicts++

  // --- speaker: exact source path and event chains, accepted only by consensus ---
  const eventSpeakers = new Set([...events].map(event => speakerForEvent(event, referencedEvents.has(event))).filter(Boolean))
  const indexedPathSpeakers = new Set([galScript?.speaker, cracked?.speaker].map(resolveSpeaker).filter(Boolean))
  const pathSpeakers = new Set(sourcePath ? [
    ...indexedPathSpeakers,
    resolveSpeaker(pathToSpeaker[sourcePath]),
    speakerFromPath(sourcePath),
    speakerFromOfficialPrefix(sourcePath)
  ].filter(Boolean) : [])
  if (sourcePath && pathSpeakers.size === 0 && (!cracked?.speakerConflict || Boolean(galScript))) {
    const leaf = basename(sourcePath).toLowerCase()
    if (!ambiguousConfirmedSourceLeaves.has(leaf) && !ambiguousConfigSpeakerLeaves.has(leaf)) {
      const configSpeaker = configSpeakerBySourceLeaf.get(leaf)?.speaker
      if (configSpeaker) pathSpeakers.add(configSpeaker)
    }
  }
  const pathSpeaker = pathSpeakers.size === 1 ? [...pathSpeakers][0] : ''
  const speakerCandidates = new Set([...eventSpeakers, pathSpeaker].filter(Boolean))
  const speaker = pathSpeakers.size <= 1 && speakerCandidates.size === 1 ? [...speakerCandidates][0] : ''
  if (pathSpeakers.size > 1 || speakerCandidates.size > 1) speakerConflicts++

  // A source path is a Wwise external-source leaf. Store the complete FNV-1
  // preimage, including its localized root and .wem suffix, so callers can
  // hash this field directly and recover the WAV id. Event-only matches do
  // not prove a filename and therefore must not populate this field.
  const inGameFilename = nativePath ?? (sourcePath && token ? `${token}/ex/${sourcePath}.wem` : '')
  const eventVoiceTypes = new Set([...referencedEvents].map(event => eventToVoiceType[event] || voiceTypeFromEventName(eventNameByHash.get(event))).filter(Boolean))
  const voiceType = (sourcePath ? voiceTypeFromPath(sourcePath) : '')
    || (eventVoiceTypes.size === 1 ? [...eventVoiceTypes][0] : '')

  if (inGameFilename) { voice.inGameFilename = String(inGameFilename); inGameFilenameMatched++ }
  if (chosenText) { voice.transcription = chosenText; transcriptionMatched++ }
  if (speaker) { voice.speaker = speaker; speakerMatched++ }
  if (voiceType) voice.voiceType = voiceType
}
const voiceCount = Object.keys(voiceMap).length
const coverage = (matched: number) => `${matched}/${voiceCount} (${voiceCount ? Math.round(matched / voiceCount * 100) : 0}%)`
console.log('Metadata coverage:')
console.log(`  inGameFilename: ${coverage(inGameFilenameMatched)}`)
console.log(`  transcription: ${coverage(transcriptionMatched)}`)
console.log(`  speaker: ${coverage(speakerMatched)}`)
console.log(`  transcription conflicts rejected: ${transcriptionConflicts}`)
console.log(`  direct GalScript disagreements resolved authoritatively: ${directGalScriptDisagreements}`)
console.log(`  speaker conflicts rejected: ${speakerConflicts}`)
console.log(`  invalid cracked filename evidence rejected: ${invalidCrackedFilenameEvidence}`)

console.log('Writing result/metadata.jsonl...')
await writeFile(join(RESULT_PATH, 'metadata.jsonl'), `${Object.values(voiceMap).map(voice => JSON.stringify(voice)).join('\n')}\n`)
console.log('Writing result.json...')
await writeFile(process.env.VOICE_RESULT_JSON_PATH || join(import.meta.dirname, 'result.json'), JSON.stringify(voiceMap))
console.log('Updating README statistics...')
const readmePath = process.env.VOICE_README_PATH || join(import.meta.dirname, 'README.md')
await updateStats(voiceMap, readmePath)
if (gameVersion) {
  const readme = await readFile(readmePath, 'utf-8')
  await writeFile(readmePath, readme.replace(/Last update at `([^`]+)`(?:, game version `[^`]+`)?/, `Last update at \`$1\`, game version \`${gameVersion}\``))
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

await copyReadme(readmePath, join(RESULT_PATH, 'README.md'), huggingfaceMetadata)
console.log('Done')
