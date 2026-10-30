import test from 'node:test'
import assert from 'node:assert/strict'
import { harness } from './harness.js'
import { structuredSummary } from './structured-summary.js'
import { estimateInput, estimateUsage } from '../src/core/token-estimator.js'
import { assertToolProtocol } from '../src/core/context-runtime.js'
import type { ChatRequest, ChatResponse } from '../src/core/contracts.js'
import { componentArmDefinitions, sourceGitPrefix } from '../scripts/swebench/component-protocol.js'
import { componentMetrics, componentExposure } from '../scripts/swebench/component-metrics.js'

// Reproduce the observed failure mode, not the private tasks: many useful
// inspections, one final repair, a 416,666-token cumulative limit. All usage
// below is synthetic, deterministically computed from each actual request.
async function trace(early: boolean, invalidSummary = false) {
  let step = 0, fixed = false
  const requests: ChatRequest[] = []
  const h = harness(async request => {
    requests.push(request)
    assertToolProtocol(request.messages ?? [])
    let response: ChatResponse
    if (request.messages?.at(-1)?.content?.includes('上面的对话正在被摘要')) {
      assert.ok(request.maxOutputTokens! <= 2048)
      response = { content: invalidSummary ? 'invalid summary' : structuredSummary('Inspected the repository; the repair remains pending.') }
    } else {
      step++
      assert.ok(request.messages?.some(message => message.role === 'user' && message.content?.includes('Inspect and repair the repository.')))
      response = step <= 24 ? { toolCalls: [{ id: `inspect-${step}`, name: 'inspect', arguments: {} }] }
        : step === 25 ? { toolCalls: [{ id: 'fix', name: 'fix', arguments: {} }] } : { content: 'done' }
    }
    const usage = estimateUsage(estimateInput(request), response)
    return { ...response, usage: { ...usage, source: 'provider', uncertain: false } }
  })
  h.tools.register({ name: 'inspect', execute: () => 'x'.repeat(10_000) })
  h.tools.register({ name: 'fix', execute: () => { fixed = true; return 'fixed' } })
  let error: unknown
  try {
    await h.agent.send('Inspect and repair the repository.', { budget: { contextWindowTokens: 1_000_000,
      maxTotalTokens: 416_666, maxModelRequests: 64, maxToolCalls: 128, maxOutputTokens: 2048, minimumOutputTokens: 512,
      ...(early ? componentArmDefinitions()[0]!.budget : { inputTargetTokens: 65_536, auto: true }) } })
  } catch (cause) { error = cause }
  const state = h.sessions.latestRun(h.session.id)!
  const events = h.sessions.confirmedEvents(h.session.id)
  return { fixed, state, events, metrics: componentMetrics(events), requests, error }
}

test('early short summaries leave cumulative budget for a repair that the old pressure line never reaches', async () => {
  const old = await trace(false)
  const full = await trace(true)
  assert.equal(old.state.status, 'token_budget')
  assert.equal(old.fixed, false)
  assert.equal(old.metrics.context.attempts, 0)
  assert.equal(full.state.status, 'completed')
  assert.equal(full.fixed, true)
  assert.ok(full.metrics.context.applied > 0)
  assert.ok(full.state.counters.totalTokens < old.state.counters.totalTokens)
  assert.ok(full.state.counters.totalTokens <= 416_666)
  assert.equal(full.state.counters.modelRequests, full.requests.length, 'summary requests are charged too')
  assert.equal(full.events.filter(event => event.type === 'tool/result' && event.data.name === 'inspect').length, 24, 'compaction never deletes the original evidence')
  assert.equal(full.events.some(event => event.type === 'context/prune'), false, 'post-compaction pruning stays disabled')
})

test('invalid early summaries remain bounded and cannot be counted as an applied component', async () => {
  const run = await trace(true, true)
  assert.equal(run.state.status, 'token_budget')
  assert.equal(run.metrics.context.attempts, 2)
  assert.equal(run.metrics.context.declined, 2)
  assert.equal(run.metrics.context.applied, 0)
  assert.equal(run.fixed, false)
  assert.ok(run.state.counters.totalTokens <= 416_666)
})

test('unreadable project snapshots are unknown evidence rather than zero rule exposure', () => {
  const h = harness(async () => ({ content: 'unused' }))
  const state = h.sessions.beginRun(h.session.id, {}, 'mock/test')
  h.sessions.append(h.session.id, 'context/snapshot', { name: 'project:context', text: 'older incompatible format', source: 'legacy-current' }, state)
  h.sessions.finishRun(state, 'completed')
  const reading = componentMetrics(h.sessions.confirmedEvents(h.session.id))
  assert.equal(reading.projectContext.snapshotParseErrors, 1)
  assert.equal(componentExposure([reading], 'projectContext').coverage, 'unknown')
  assert.equal(componentExposure([reading], 'context').coverage, 'not-exercised')
})

test('WSL source queries adapt Windows worktree metadata without setting process-wide Git variables', () => {
  const before = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE }
  const pointer = 'gitdir: D:\\Agent\\a repo\\.git\\worktrees\\eval\r\n'
  assert.deepEqual(sourceGitPrefix(pointer, '/mnt/d/Agent/a checkout', 'linux'), [
    '--git-dir', '/mnt/d/Agent/a repo/.git/worktrees/eval', '--work-tree', '/mnt/d/Agent/a checkout', '-c', 'core.autocrlf=true',
  ])
  assert.deepEqual(sourceGitPrefix(pointer, 'D:/Agent/a checkout', 'win32'), [])
  assert.deepEqual(sourceGitPrefix('gitdir: /home/user/repo/.git/worktrees/eval\n', '/home/user/eval', 'linux'), [])
  assert.deepEqual({ dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE }, before)
})
