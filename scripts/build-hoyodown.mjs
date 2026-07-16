import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const source = resolve(root, 'HoyoDown')
const executableName = process.platform === 'win32' ? 'hoyodown.exe' : 'hoyodown'
const output = resolve(source, executableName)
const result = spawnSync('go', ['build', '-o', output, './cmd/hoyodown'], {
  cwd: source,
  stdio: 'inherit'
})

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
