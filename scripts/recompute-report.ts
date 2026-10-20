import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { inspectSession } from '../src/core/session-inspect.js'
import type { SessionEvent } from '../src/core/contracts.js'
import { formatResults, summarize } from './export-public-evidence.js'

// R09：离线复算。不加载模型、不联网、不需要 API key；只读样例目录，先核对每个文件的
// SHA256SUMS，再从事件日志重算 report 并重建 RESULTS.md。
const args = process.argv.slice(2)
const check = args.includes('--check')
const samples = path.resolve(args.find(argument => !argument.startsWith('--')) ?? 'docs/samples')
const resultsFile = path.resolve('docs/RESULTS.md')
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

async function verifyChecksums(directory: string) {
  const text = await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8')
  for (const line of text.trim().split('\n')) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line)
    if (!match) throw new Error(`${directory}: invalid SHA256SUMS line`)
    const actual = sha256(await fs.readFile(path.join(directory, match[2]!)))
    if (actual !== match[1]) throw new Error(`${directory}/${match[2]}: checksum mismatch`)
  }
}

async function main() {
  const entries = (await fs.readdir(samples, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  if (!entries.length) throw new Error(`no evidence episodes under ${samples}`)
  const reports: { name: string; report: ReturnType<typeof summarize> }[] = []
  const verifications: { name: string; accepted: boolean }[] = []
  for (const name of entries) {
    const directory = path.join(samples, name)
    await verifyChecksums(directory)
    const eventsFile = path.join(directory, 'events.jsonl')
    const events = (await fs.readFile(eventsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as SessionEvent)
    const expected = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8')) as ReturnType<typeof summarize>
    const recomputed = summarize(events)
    if (JSON.stringify(recomputed) !== JSON.stringify(expected)) {
      throw new Error(`${name}: report.json does not match the recomputed report\n${JSON.stringify({ expected, recomputed }, null, 2)}`)
    }
    const verification = JSON.parse(await fs.readFile(path.join(directory, 'verification.json'), 'utf8')) as { accepted: boolean }
    const inspected = await inspectSession(eventsFile)
    if (!inspected.integrity.complete) throw new Error(`${name}: events.jsonl is not a complete readable log`)
    reports.push({ name, report: recomputed })
    verifications.push({ name, accepted: verification.accepted })
    console.log(`ok ${name}: ${recomputed.requests.dispatched} requests, ${recomputed.tools.calls} tools, $${recomputed.costUsd.toFixed(9)}`)
  }
  const rendered = formatResults(reports, verifications)
  if (check) {
    const actual = await fs.readFile(resultsFile, 'utf8')
    if (actual !== rendered) throw new Error(`${resultsFile} does not match the recomputed results; run evidence:export to regenerate`)
    console.log(`ok ${resultsFile} matches ${reports.length} episodes`)
  } else {
    await fs.writeFile(resultsFile, rendered)
    console.log(`wrote ${resultsFile}`)
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
