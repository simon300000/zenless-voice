import { readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { spawn, execFile } from 'child_process'
import { promisify } from 'util'

import { galGameBlockNamesFromCatalog, galGamePerformAssetPaths, isGzip } from './galgame-perform.js'

const root = import.meta.dirname
const dataPath = join(root, 'ZenlessData')
const downloader = join(root, 'HoyoDown', 'hoyodown')
const outputPath = join(root, 'StreamingAssets')
const performOutputPath = process.env.VOICE_GALGAME_PERFORM_PATH || join(outputPath, 'GalGamePerform')
const performTemplatePath = join(dataPath, 'FileCfg', 'PerformTemplateTb.json')
const execFileAsync = promisify(execFile)
const dryRun = process.argv.includes('--dry-run')
const performOnly = process.argv.includes('--perform-only')

const packages = [
  'zh-cn',
  'en-us',
  'ja-jp',
  'ko-kr'
] as const

const run = (command: string, args: string[]) => new Promise<void>((resolveRun, reject) => {
  const child = spawn(command, args, { stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited with code ${code ?? 'unknown'}`)))
})

const commitSubject = await (async () => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dataPath, 'log', '-1', '--format=%s'])
    return stdout.trim()
  } catch (error) {
    throw new Error(`Cannot read the latest ZenlessData commit: ${error instanceof Error ? error.message : error}`)
  }
})()

const version = commitSubject.match(/(?:Win|REL)(\d+\.\d+\.\d+)/i)?.[1]
if (!version) throw new Error(`No game version found in ZenlessData commit subject: ${commitSubject}`)

try {
  await stat(downloader)
} catch {
  throw new Error('HoyoDown is not built; run npm run build first')
}

console.log(`ZenlessData commit: ${commitSubject}`)
console.log(performOnly ? `Downloading Zenless ${version} GalGame Perform resources` : `Downloading Zenless ${version} voice packages into ${outputPath}`)

if (!performOnly) {
  for (const name of packages) {
    console.log(`\n--- ${name} ---`)
    await run(downloader, [
      'game', 'nap', version, name, outputPath,
      '--yes',
      ...(dryRun ? ['--dry-run'] : [])
    ])
  }
}

const gameStreamingRoot = 'ZenlessZoneZero_Data/StreamingAssets'
const downloadGameFile = (file: string) => run(downloader, [
  'game', 'nap', version, 'game', performOutputPath, file,
  '--yes',
  ...(dryRun ? ['--dry-run'] : [])
])

console.log(`\n--- GalGame Perform resources ---`)
const resVersionRemote = `${gameStreamingRoot}/res_version`
await downloadGameFile(resVersionRemote)
if (!dryRun) {
  const resVersion = JSON.parse(await readFile(join(performOutputPath, resVersionRemote), 'utf8')) as {
    files?: { remoteName?: string, tags?: unknown[] }[]
  }
  const performTemplate = JSON.parse(await readFile(performTemplatePath, 'utf8')) as unknown
  const assetPaths = galGamePerformAssetPaths(performTemplate)
  const candidates = (resVersion.files ?? [])
    .filter(file => /^Blocks\/\d+\.blk$/.test(file.remoteName ?? '') && !(file.tags?.length))
    .map(file => file.remoteName!)

  let catalogRemote = ''
  let targetBlocks: string[] = []
  let matchedAssets = 0
  for (const candidate of candidates) {
    const remote = `${gameStreamingRoot}/${candidate}`
    await downloadGameFile(remote)
    const contents = await readFile(join(performOutputPath, remote))
    if (!isGzip(contents)) continue
    try {
      const resolved = galGameBlockNamesFromCatalog(contents, assetPaths)
      if (!resolved.blocks.length) continue
      catalogRemote = remote
      targetBlocks = resolved.blocks.map(block => `${gameStreamingRoot}/${block}`)
      matchedAssets = resolved.matchedAssets
      break
    } catch { /* another untagged block may be the asset catalog */ }
  }
  if (!catalogRemote) throw new Error('Cannot find the official ZZZ asset catalog in res_version')

  for (const block of targetBlocks) await downloadGameFile(block)
  await writeFile(join(performOutputPath, 'manifest.json'), JSON.stringify({
    gameVersion: version,
    catalog: catalogRemote,
    blocks: targetBlocks,
    matchedAssets,
    totalAssets: assetPaths.length
  }, null, 2) + '\n')
  console.log(`${matchedAssets}/${assetPaths.length} GalGame Perform assets resolved to ${targetBlocks.length} official resource blocks.`)
}

console.log(dryRun ? '\nThe requested packages and GalGame resource index are available.' : '\nThe requested voice packages and GalGame Perform resources are ready.')
