import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { loadNativeGameData, mergeVoiceTextMaps } from '../native-game-data.js'
import { fnv1 } from '../hoyo-voice-extractor/fnvjs/src/index.js'

async function fixture(run, indexed = false) {
  const root = await mkdtemp(join(tmpdir(), 'zenless-native-'))
  const inventory = []
  async function put(name, object) {
    const data = JSON.stringify(object)
    await mkdir(dirname(join(root, name)), { recursive: true })
    await writeFile(join(root, name), data)
    inventory.push({ path: name, sha256: createHash('sha256').update(data).digest('hex') })
  }
  const path = 'Chinese(PRC)/ex/VO_Galgame/VO_Wise/GalGame_Wise_001.wem'
  const hash = fnv1(path.toLowerCase(), 64).toString(16).padStart(16, '0')
  for (const [token, locale] of [['Cn', 'zh-cn'], ['En', 'en'], ['Jp', 'ja'], ['Kr', 'ko']]) {
    await put(`TextMap/${locale}/main.json`, { line1: 'Hello' })
    await put(`Indexes/Audio/WemPathMap.${token}.json`, token === 'Cn' ? { [hash]: [path] } : {})
  }
  await put('scene.json', { data: [
    { externalVoiceKey: 'GalGame_Wise_001', dialogueKey: 'line1' },
    { Voice: 'Accompany_Wise_Laugh_01', Text: 'unrelated subtitle' }
  ] })
  await put('Indexes/Audio/OdinVoiceNameFields.json', [
    { objectPath: 'scene.json', fieldPath: '/data/0/externalVoiceKey', nativeValue: 'GalGame_Wise_001', matchMode: 'whole-native-string' },
    { objectPath: 'scene.json', fieldPath: '/data/1/Voice', nativeValue: 'Accompany_Wise_Laugh_01', matchMode: 'whole-native-string' }
  ])
  let coverage
  if (indexed) {
    const layers = {}
    for (const locale of ['zh-cn', 'en', 'ja', 'ko']) {
      await put(`TextMap/${locale}/login.json`, { login: 'Login' })
      const entry = family => {
        const path = `TextMap/${locale}/${family}.json`
        return { path, records: 1, sha256: inventory.find(row => row.path === path).sha256 }
      }
      layers[locale] = { main: entry('main'), login: entry('login') }
    }
    await put('TextMap/zh-cn/overwrite.json', { line1: '' })
    layers['zh-cn'].overwrite = { path: 'TextMap/zh-cn/overwrite.json', records: 1,
      sha256: inventory.find(row => row.path === 'TextMap/zh-cn/overwrite.json').sha256 }
    await put('TextMap/Index.json', { build: { version: '3.2.0', region: 'global' }, layers,
      lookupOrder: ['overwrite', 'main', 'login'], emptyStringStopsFallback: true })
    coverage = { textMapLayers: { indexPath: 'TextMap/Index.json' } }
  }
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ build: { version: '3.2.0', region: 'global' }, coverage }))
  await writeFile(join(root, 'files.jsonl'), inventory.map(row => JSON.stringify(row)).join('\n'))
  try { await run(root, hash, path) } finally { await rm(root, { recursive: true, force: true }) }
}

test('joins exact native dialogue fields; excludes accompanying bubble cues', () => fixture(async (root, hash, path) => {
  const native = await loadNativeGameData(root, '3.2.0')
  assert.equal(native.paths.get(`Chinese:${hash}`), path)
  assert.deepEqual(native.links.map(({ source, textId }) => ({ source, textId })), [{ source: 'GalGame_Wise_001', textId: 'line1' }])
  assert.equal(native.provenance.ignoredBubbleCues, 1)
}))
test('rejects a different release', () => fixture(async root => {
  await assert.rejects(loadNativeGameData(root, '3.1.0'), /must be Global/)
}))
test('rejects modified source even if its JSON is valid', () => fixture(async root => {
  await writeFile(join(root, 'scene.json'), '{}')
  await assert.rejects(loadNativeGameData(root, '3.2.0'), /hash mismatch/)
}))

test('explicit overwrite layer supersedes even nonempty main and preserves empty hits', () => {
  const result = mergeVoiceTextMaps({main:{ko:'-', revised:'old', empty:'must not leak', unchanged:'native'}},
    {unchanged:'reference'}, {ko:'딱 맞게 왔네…', revised:'new', empty:''})
  assert.equal(result.textMap.ko,'딱 맞게 왔네…')
  assert.equal(result.textMap.revised,'new')
  assert.equal(result.textMap.empty,'')
  assert.equal(result.textMap.unchanged,'native')
  assert.equal(result.provenance.overwriteSource,'supplemental-overwrite')
})
test('native overwrite is authoritative and does not mix a supplemental layer into gaps', () => {
  const result=mergeVoiceTextMaps({overwrite:{a:''},main:{a:'old',b:'main'},login:{c:'login'}}, {ghost:'stale removed key'}, {a:'wrong',b:'wrong'})
  assert.deepEqual(result.textMap,{a:'',b:'main',c:'login'})
  assert.equal(result.provenance.overwriteSource,'native-overwrite')
})
test('reads the inventoried layer index and preserves an explicit empty native overwrite', () => fixture(async root => {
  const native = await loadNativeGameData(root, '3.2.0')
  const result = mergeVoiceTextMaps(native.textMapLayers.Chinese, {}, { line1: 'Must not leak' })
  assert.equal(result.textMap.line1, '')
  assert.equal(result.textMap.login, 'Login')
}, true))
