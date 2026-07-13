import { stat } from 'fs/promises'
import { join } from 'path'
import { spawn, execFile } from 'child_process'
import { promisify } from 'util'

const root = import.meta.dirname
const dataPath = join(root, 'ZenlessData')
const downloader = join(root, 'HoyoDown', 'hoyodown')
const outputPath = join(root, 'StreamingAssets')
const execFileAsync = promisify(execFile)
const dryRun = process.argv.includes('--dry-run')

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
console.log(`Downloading Zenless ${version} voice packages into ${outputPath}`)

for (const name of packages) {
  console.log(`\n--- ${name} ---`)
  await run(downloader, [
    'game', 'nap', version, name, outputPath,
    '--yes',
    ...(dryRun ? ['--dry-run'] : [])
  ])
}

console.log(dryRun ? '\nAll four voice packages are available.' : '\nAll four voice packages are ready.')
