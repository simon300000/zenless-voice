import { readFile } from 'fs/promises'
import { createHash } from 'crypto'
import { resolve, sep } from 'path'
import { fnv1 } from './hoyo-voice-extractor/fnvjs/src/index.js'

type TextMap = Record<string, string>
type TextMapLayers = Partial<Record<'overwrite' | 'main' | 'login', TextMap>>

export function mergeVoiceTextMaps(native: TextMapLayers, supplementalMain: TextMap, supplementalOverwrite: TextMap) {
  // Layer precedence is based on key existence, not truthiness or punctuation.
  // An installed native overwrite is a complete layer; never mix an older
  // supplemental overwrite into gaps of that native layer.
  const layers: [string, TextMap][] = [
    [native.overwrite === undefined ? 'supplemental-overwrite' : 'native-overwrite', native.overwrite ?? supplementalOverwrite],
    [native.main === undefined ? 'supplemental-main' : 'native-main', native.main ?? supplementalMain],
    ['native-login', native.login ?? {}]
  ]
  const textMap: TextMap = {}
  const origins: Record<string, number> = {}
  for (const [name, layer] of layers) {
    origins[name] = 0
    for (const [key, value] of Object.entries(layer)) {
      if (Object.hasOwn(textMap, key)) continue
      textMap[key] = value
      origins[name]++
    }
  }
  return { textMap, provenance: { origins, overwriteSource: layers[0][0], emptyStringStopsFallback: true } }
}

// Only consume inventoried export files, never infer text from a voice stem.
export async function loadNativeGameData(root: string, version: string) {
  const manifestBytes = await readFile(resolve(root, 'manifest.json'))
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (!version || manifest.build?.version !== version || manifest.build?.region !== 'global') {
    throw new Error(`Native game data must be Global ${version}; got ${JSON.stringify(manifest.build)}`)
  }
  const inventory = new Map<string, { sha256: string }>()
  for (const line of (await readFile(resolve(root, 'files.jsonl'), 'utf8')).trim().split(/\r?\n/)) {
    const row = JSON.parse(line)
    inventory.set(row.path, row)
  }
  const consumed = new Map<string, string>()
  const readVerified = async (name: string) => {
    const file = resolve(root, name)
    if (!file.startsWith(resolve(root) + sep)) throw new Error(`Unsafe native path: ${name}`)
    const expected = inventory.get(name)
    if (!expected) throw new Error(`Native file missing from inventory: ${name}`)
    const bytes = await readFile(file)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== expected.sha256.toLowerCase()) throw new Error(`Native file hash mismatch: ${name}`)
    consumed.set(name, sha256)
    return JSON.parse(bytes.toString('utf8'))
  }
  const textMapLayers: Record<string, TextMapLayers> = {}
  const indexPath = manifest.coverage?.textMapLayers?.indexPath
  const textMapIndex = indexPath ? await readVerified(indexPath) : undefined
  if (textMapIndex && (textMapIndex.build?.version !== version || textMapIndex.build?.region !== 'global'
    || JSON.stringify(textMapIndex.lookupOrder) !== JSON.stringify(['overwrite', 'main', 'login'])
    || textMapIndex.emptyStringStopsFallback !== true)) throw new Error('Native TextMap layer contract/version mismatch')
  const paths = new Map<string, string>()
  let ambiguousPaths = 0
  for (const [token, language, locale] of [
    ['Cn', 'Chinese', 'zh-cn'], ['En', 'English', 'en'],
    ['Jp', 'Japanese', 'ja'], ['Kr', 'Korean', 'ko']
  ]) {
    const layers: TextMapLayers = {}
    if (textMapIndex) {
      const definitions = textMapIndex.layers?.[locale]
      if (!definitions?.main || !definitions?.login) throw new Error(`Incomplete native TextMap index: ${locale}`)
      for (const family of ['overwrite', 'main', 'login'] as const) {
        const entry = definitions[family]
        if (!entry) continue
        if (inventory.get(entry.path)?.sha256.toLowerCase() !== entry.sha256.toLowerCase()) throw new Error('Native TextMap index/inventory hash mismatch')
        const values = await readVerified(entry.path)
        if (Object.keys(values).length !== entry.records || Object.values(values).some(value => typeof value !== 'string')) throw new Error('Native TextMap layer content mismatch')
        layers[family] = values
      }
    } else {
      layers.main = await readVerified(`TextMap/${locale}/main.json`)
    }
    textMapLayers[language] = layers
    const mapping = await readVerified(`Indexes/Audio/WemPathMap.${token}.json`) as Record<string, string[]>
    for (const [hex, candidates] of Object.entries(mapping)) {
      const unique = [...new Set(candidates.map(path => path.toLowerCase()))]
      if (unique.length !== 1) { ambiguousPaths++; continue }
      const path = candidates[0]
      if (fnv1(path.toLowerCase(), 64).toString(16).padStart(16, '0') !== hex) {
        throw new Error(`Native path does not hash to its PCK id: ${hex}`)
      }
      paths.set(`${language}:${hex}`, path)
    }
  }
  const fields = await readVerified('Indexes/Audio/OdinVoiceNameFields.json') as {
    objectPath: string, fieldPath: string, nativeValue: string, matchedStem: string, matchMode: string
  }[]
  const byObject = new Map<string, typeof fields>()
  for (const field of fields) {
    const group = byObject.get(field.objectPath) ?? []
    group.push(field)
    byObject.set(field.objectPath, group)
  }
  const links: { source: string, textId: string, objectPath: string, fieldPath: string }[] = []
  let ignoredBubbleCues = 0
  for (const [objectPath, entries] of byObject) {
    const object = await readVerified(objectPath)
    for (const entry of entries) {
      const parts = entry.fieldPath.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
      const field = parts.pop()!
      let parent = object
      for (const part of parts) parent = parent?.[part]
      if (parent?.[field] !== entry.nativeValue || entry.matchMode !== 'whole-native-string') {
        throw new Error(`Native voice field mismatch: ${objectPath}${entry.fieldPath}`)
      }
      // Bubble Voice can be a laugh/effort accompanying unrelated screen text.
      if (field === 'Voice') { ignoredBubbleCues++; continue }
      const textId = field === 'ExternalVoiceKey' ? parent.DialogueKey : parent.dialogueKey
      if (!['externalVoiceKey', 'voiceKey', 'ExternalVoiceKey'].includes(field) || typeof textId !== 'string' || !textId) continue
      links.push({ source: entry.nativeValue, textId, objectPath, fieldPath: entry.fieldPath })
    }
  }
  return {
    textMapLayers, paths, links,
    provenance: {
      root: resolve(root), version, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      pathMappings: paths.size, ambiguousPaths, directLinks: links.length, ignoredBubbleCues,
      textMapLayerIndex: textMapIndex ? { status: textMapIndex.status, missingOverwriteLocales: textMapIndex.missingOverwriteLocales,
        provenance: textMapIndex.provenance } : { status: 'legacy-main-only-export' },
      files: [...consumed].map(([path, sha256]) => ({ path, sha256 }))
    }
  }
}
