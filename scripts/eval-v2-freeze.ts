import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { freezeV2 } from './eval-v2-report.js'
import type { V2FreezeInput } from './eval-v2-report.js'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--output') throw new Error('usage: eval:v2-freeze --config FILE --output FILE')
const config = JSON.parse(await fs.readFile(args[1]!, 'utf8')) as Omit<V2FreezeInput, 'gitCommit'>
const status = execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' })
if (status.trim()) throw new Error('V2 freeze requires a clean checkout; commit fixture and source changes first')
const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
if (config.split === 'component') {
  if (!config.sourceBaseCommit || !/^[0-9a-f]{40}$/.test(config.sourceBaseCommit)) throw new Error('component freeze requires a 40-hex sourceBaseCommit')
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', config.sourceBaseCommit, gitCommit], { cwd: repository, stdio: 'ignore' })
  } catch {
    throw new Error('component sourceBaseCommit must be an ancestor of the evaluation commit')
  }
}
const manifest = await freezeV2({ ...config, gitCommit })
await fs.writeFile(args[3]!, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify({ output: args[3], digest: manifest.digest, sourceBaseCommit: manifest.sourceBaseCommit ?? null, gitCommit: manifest.gitCommit, tasks: manifest.tasks.length, episodes: manifest.episodes.length }))
