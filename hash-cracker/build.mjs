import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const configure = spawnSync('cmake', ['-S', root, '-B', join(root, 'build'), '-DCMAKE_BUILD_TYPE=Release'], { stdio: 'inherit' })
if (configure.error) throw configure.error
if (configure.status !== 0) process.exit(configure.status ?? 1)
const build = spawnSync('cmake', ['--build', join(root, 'build'), '--config', 'Release'], { stdio: 'inherit' })
if (build.error) throw build.error
process.exit(build.status ?? 1)

