import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWorkerReport, workerGuidance } from '../src/orchestration/worker.js'
import { findScopeViolations, writeSetCovers } from '../src/orchestration/integrator.js'
import { resolveRootBudget } from '../src/orchestration/orchestrator.js'

test('worker reports are bounded, optional and never trusted beyond their fields', () => {
  const report = parseWorkerReport('done\n```json\n{"status":"done","summary":"wrote a","uncertainties":["bom"],"sources":[{"path":"src/a.txt"}]}\n```')
  assert.deepEqual(report, { status: 'done', summary: 'wrote a', uncertainties: ['bom'], sources: [{ path: 'src/a.txt' }], valid: true, truncated: false })
  assert.equal(parseWorkerReport('```json\n{"status":"needs_input","summary":"need spec"}\n```').status, 'needs_input')
  assert.equal(parseWorkerReport('no json here').valid, false)
  assert.equal(parseWorkerReport('```json\n{"status":"weird","summary":"x"}\n```').valid, false)
  const oversized = parseWorkerReport(`\`\`\`json\n${JSON.stringify({ status: 'done', summary: 'x'.repeat(5000) })}\n\`\`\``)
  assert.equal(oversized.valid, true)
  assert.equal(oversized.truncated, true)
  assert.ok(Buffer.byteLength(oversized.summary) <= 2048)
})

test('write-set coverage accepts exact files and directory prefixes only', () => {
  assert.equal(writeSetCovers('src/a.ts', ['src/a.ts']), true)
  assert.equal(writeSetCovers('src/a.ts', ['src/']), true)
  assert.equal(writeSetCovers('src/deep/a.ts', ['src/']), true)
  assert.equal(writeSetCovers('src/a.ts', ['src']), false)
  assert.equal(writeSetCovers('test/a.ts', ['src/']), false)
  assert.deepEqual(findScopeViolations(['src/a.ts', 'outside.txt'], ['src/']), ['outside.txt'])
  assert.equal(writeSetCovers('./src/a.ts', ['src/a.ts']), true)
})

test('worker guidance states the write set, acceptance and report contract', () => {
  const guidance = workerGuidance({
    rootGoal: 'goal', subtaskId: 'st-1', title: 'title', objective: 'objective', writeSet: ['src/a.ts'],
    readHints: ['docs/spec.md'], acceptance: { commands: ['node check.mjs'] }, baseCommit: 'a'.repeat(40), planVersion: 1,
  })
  assert.match(guidance, /src\/a\.ts/)
  assert.match(guidance, /node check\.mjs/)
  assert.match(guidance, /Do not run git commit/)
  assert.match(guidance, /"status":"done"/)
})

test('root budget defaults and validation are explicit', () => {
  const budget = resolveRootBudget({}, 2)
  assert.equal(budget.maxInFlightRequests, 3)
  assert.equal(budget.maxModelRequests, 96)
  assert.throws(() => resolveRootBudget({ unknown: 1 } as never), /unknown root budget key/)
  assert.throws(() => resolveRootBudget({ maxModelRequests: 0 }), /invalid root budget/)
  assert.equal(resolveRootBudget({ maxInFlightRequests: 4 }, 2).maxInFlightRequests, 4)
})
