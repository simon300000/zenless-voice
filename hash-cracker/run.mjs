import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const executable = join(root, 'build', 'bin', process.platform === 'win32' ? 'zenless-hash-cracker.exe' : 'zenless-hash-cracker')
const result = spawnSync(executable, process.argv.slice(2), { stdio: 'inherit', env: process.env })
if (result.error) throw result.error
process.exit(result.status ?? 1)
