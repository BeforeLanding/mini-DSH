import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
function compile(args) {
  const result = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.json', ...args], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
compile(['--noEmit'])
const output = fileURLToPath(new URL('../dist/', import.meta.url))
if (output !== fileURLToPath(new URL('dist/', new URL('../', import.meta.url)))) throw new Error('invalid output path')
rmSync(output, { recursive: true, force: true })
compile([])
