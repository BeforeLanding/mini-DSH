import test from 'node:test'
import assert from 'node:assert/strict'
import { ApprovalBroker } from '../src/orchestration/approval-broker.js'
import type { ApprovalRequestedData, ApprovalResolvedData } from '../src/orchestration/contracts.js'

const bash = (summary: string): { tool: string; summary: string } => ({ tool: 'bash', summary })
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

test('approval requests are shown one at a time in FIFO order', async () => {
  const shown: string[] = []
  let active = 0, peak = 0
  const broker = new ApprovalBroker({
    policy: { writes: 'auto', bash: 'ask', perRequestTimeoutMs: 1000 },
    prompt: async (_request, meta) => {
      active++; peak = Math.max(peak, active)
      shown.push(`show:${meta.attemptId}`)
      await pause()
      active--; shown.push(`done:${meta.attemptId}`)
      return true
    },
  })
  const results = await Promise.all([
    broker.request('at-a', bash('first')),
    broker.request('at-b', bash('second')),
    broker.request('at-c', bash('third')),
  ])
  assert.deepEqual(results, [true, true, true])
  assert.equal(peak, 1)
  assert.deepEqual(shown, ['show:at-a', 'done:at-a', 'show:at-b', 'done:at-b', 'show:at-c', 'done:at-c'])
  assert.equal(broker.pending, 0)
})

test('D8 policy auto-approves worktree writes but still asks for Bash', async () => {
  const requested: ApprovalRequestedData[] = [], resolved: ApprovalResolvedData[] = []
  const prompts: string[] = []
  const broker = new ApprovalBroker({
    policy: { writes: 'auto', bash: 'ask', perRequestTimeoutMs: 1000 },
    prompt: async request => { prompts.push(request.tool); return true },
    writeSetFor: attemptId => attemptId === 'at-a' ? ['src/a.ts'] : undefined,
    onRequested: data => { requested.push(data) },
    onResolved: data => { resolved.push(data) },
  })
  assert.equal(await broker.request('at-a', { tool: 'write_file', summary: 'write a' }), true)
  assert.equal(prompts.length, 0)
  assert.equal(requested[0]?.tool, 'write_file')
  assert.match(requested[0]?.summaryHash ?? '', /^[a-f0-9]{64}$/)
  assert.deepEqual(requested[0]?.writeSet, ['src/a.ts'])
  assert.equal(resolved[0]?.source, 'auto')
  assert.equal(await broker.request('at-a', bash('run tests')), true)
  assert.deepEqual(prompts, ['bash'])
  assert.equal(resolved[1]?.source, 'user')
  const askWrites = new ApprovalBroker({ policy: { writes: 'ask', bash: 'ask', perRequestTimeoutMs: 1000 }, prompt: async () => false })
  assert.equal(await askWrites.request('at-b', { tool: 'edit_file', summary: 'edit' }), false)
})

test('the display timeout starts only when the request is shown and is audited', async () => {
  const resolved: ApprovalResolvedData[] = []
  const broker = new ApprovalBroker({
    policy: { writes: 'auto', bash: 'ask', perRequestTimeoutMs: 20 },
    prompt: async () => new Promise<boolean>(() => {}),
    onResolved: data => { resolved.push(data) },
  })
  const started = Date.now()
  assert.equal(await broker.request('at-a', bash('blocked')), false)
  assert.ok(Date.now() - started >= 15)
  assert.equal(resolved[0]?.source, 'timeout')
  assert.equal(resolved[0]?.allowed, false)
})

test('cancelling an attempt rejects its queued requests and aborts the active one', async () => {
  const broker = new ApprovalBroker({ policy: { writes: 'auto', bash: 'ask', perRequestTimeoutMs: 5000 }, prompt: async () => new Promise<boolean>(() => {}) })
  const first = broker.request('at-a', bash('active'))
  const second = broker.request('at-a', bash('queued'))
  await pause()
  broker.cancelAttempt('at-a')
  assert.deepEqual(await Promise.all([first, second]), [false, false])
  assert.equal(broker.pending, 0)
  assert.equal(await broker.request('at-a', bash('after cancel')), false)
})

test('closing the channel rejects queued requests with cancelled', async () => {
  const resolved: ApprovalResolvedData[] = []
  const broker = new ApprovalBroker({
    policy: { writes: 'auto', bash: 'ask', perRequestTimeoutMs: 5000 },
    prompt: async () => new Promise<boolean>(() => {}),
    onResolved: data => { resolved.push(data) },
  })
  const active = broker.request('at-a', bash('active'))
  const queued = broker.request('at-b', bash('queued'))
  await pause()
  await broker.close()
  assert.deepEqual(await Promise.all([active, queued]), [false, false])
  assert.ok(resolved.every(item => item.source === 'cancelled'))
})
