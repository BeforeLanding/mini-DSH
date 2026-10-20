import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { inspectSession } from '../src/core/session-inspect.js'
import type { SessionEvent } from '../src/core/contracts.js'
import { formatResults, summarize } from '../scripts/export-public-evidence.js'

const samples = path.resolve('docs/samples')
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

test('public synthetic episodes verify, recompute, inspect, and match RESULTS.md', async () => {
  const names = (await fs.readdir(samples, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  assert.deepEqual(names, ['normal-fix', 'provider-recovery'])
  const reports: { name: string; report: ReturnType<typeof summarize> }[] = []
  const verifications: { name: string; accepted: boolean }[] = []
  for (const name of names) {
    const directory = path.join(samples, name)
    const sums = (await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8')).trim().split('\n')
    assert.ok(sums.length >= 5)
    for (const line of sums) {
      const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line)
      assert.ok(match, `${name}: malformed checksum line`)
      assert.equal(sha256(await fs.readFile(path.join(directory, match[2]!))), match[1], `${name}/${match[2]}`)
    }
    const text = await fs.readFile(path.join(directory, 'events.jsonl'), 'utf8')
    assert.doesNotMatch(text, /[A-Za-z]:\\\\|\/Users\/|\/home\//, `${name}: unsanitized absolute path`)
    const events = text.trim().split('\n').map(line => JSON.parse(line) as SessionEvent)
    const report = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8')) as ReturnType<typeof summarize>
    assert.deepEqual(summarize(events), report, `${name}: report is not reproducible`)
    const inspected = await inspectSession(path.join(directory, 'events.jsonl'))
    assert.equal(inspected.integrity.complete, true, name)
    const verification = JSON.parse(await fs.readFile(path.join(directory, 'verification.json'), 'utf8')) as { accepted: boolean }
    assert.equal(verification.accepted, true, name)
    reports.push({ name, report })
    verifications.push({ name, accepted: verification.accepted })
  }
  const recovery = reports.find(item => item.name === 'provider-recovery')!
  assert.ok(recovery.report.requests.retries >= 1)
  assert.equal(await fs.readFile(path.resolve('docs/RESULTS.md'), 'utf8'), formatResults(reports, verifications))
})
