import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const repository = dirname(root)
const executable = join(root, 'build', 'bin', process.platform === 'win32' ? 'zenless-hash-cracker.exe' : 'zenless-hash-cracker')
const resultRootValue = process.env.VOICE_RESULT_PATH || join(repository, 'result')
const resultRoot = isAbsolute(resultRootValue) ? resultRootValue : resolve(resultRootValue)
const performRootValue = process.env.VOICE_GALGAME_PERFORM_PATH || join(repository, 'StreamingAssets', 'GalGamePerform')
const performRoot = isAbsolute(performRootValue) ? performRootValue : resolve(performRootValue)
const dictionaryPath = join(resultRoot, 'galgame-perform-links.tsv')
const environment = { ...process.env }

try {
  const { galGameLinksFromBlocks } = await import('../galgame-perform.js')
  const manifest = JSON.parse(await readFile(join(performRoot, 'manifest.json'), 'utf8'))
  if (!Array.isArray(manifest.blocks) || !manifest.blocks.every(block => typeof block === 'string')) throw new Error('invalid manifest')
  const extracted = galGameLinksFromBlocks(await Promise.all(manifest.blocks.map(block => readFile(join(performRoot, block)))))
  await mkdir(resultRoot, { recursive: true })
  await writeFile(dictionaryPath,
    '# GalScript voiceKey/externalVoiceKey\tdialogueKey\n' +
    [...extracted.links].sort(([left], [right]) => left.localeCompare(right)).map(([source, textId]) => `${extracted.sourceNames.get(source) ?? source}\t${textId}\n`).join(''))
  environment.VOICE_GALSCRIPT_DICTIONARY = dictionaryPath
  console.log(`Loaded ${extracted.links.size} game-owned GalScript voice keys for filename cracking`)
} catch (error) {
  console.log(`GalScript filename dictionary unavailable: ${error instanceof Error ? error.message : error}`)
}

const result = spawnSync(executable, process.argv.slice(2), { stdio: 'inherit', env: environment })
if (result.error) throw result.error
process.exit(result.status ?? 1)
