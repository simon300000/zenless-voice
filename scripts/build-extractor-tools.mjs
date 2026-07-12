import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

for (const tool of ['quickpck', 'wwise']) {
  const source = resolve(root, 'hoyo-voice-extractor', tool)
  const build = resolve(source, 'build')

  for (const args of [
    ['-S', source, '-B', build, '-DCMAKE_BUILD_TYPE=Release'],
    ['--build', build, '--config', 'Release'],
  ]) {
    const result = spawnSync('cmake', args, { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}
