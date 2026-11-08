import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatRequest, ChatResponse } from '../src/core/contracts.js'
import type { PlanInput } from '../src/orchestration/contracts.js'
import { commitAll, git, headCommit, stageAll, statusPorcelain } from '../src/orchestration/git.js'
import { formatOrchestration, loadOrchestration } from '../src/orchestration/inspect.js'
import { orchestrate } from '../src/orchestration/orchestrator.js'
import { inspectSession } from '../src/core/session-inspect.js'
import { readFixtureFile } from './coding-fixtures.js'
import {
  evaluateOrchestrationFixture, fixturePlan, materializeOrchestrationFixture, orchestrationFixtures,
  type OrchestrationFixtureId,
} from './orchestration-fixtures.js'

// 离线演示：脚本模型 + 真 git；不配置 provider，也不请求任何付费 API。
// single 演示 planner 判定 single；parallel 演示两个 worker 区间重叠、第三个子任务在第二波次
// 读取整合后的依赖产物。隐藏验收器在演示最后独立运行，作为行为验收结论。
const mode = process.argv[2] === '--mode' ? process.argv[3] : undefined
if (mode !== 'single' && mode !== 'parallel') throw new Error('usage: demo-orchestrate --mode single|parallel')
const fixtureId: OrchestrationFixtureId = mode === 'parallel' ? 'parallel-composite' : 'single-repair'
const fixture = orchestrationFixtures[fixtureId]
const repository = fileURLToPath(new URL('../../', import.meta.url))
const reportReference = path.join(repository, 'test', 'fixtures', 'orchestration', 'parallel-composite', 'reference', 'packages/report/src/report.mjs')

const root = await fs.mkdtemp(path.join(os.tmpdir(), `mini-orch-demo-${mode}-`))
const repo = path.join(root, 'repo'), baseDirectory = path.join(root, 'orchestrations')
await materializeOrchestrationFixture(fixtureId, repo)
await git(repo, ['init', '--quiet'])
await git(repo, ['config', 'core.autocrlf', 'false'])
await stageAll(repo)
const baseCommit = await commitAll(repo, 'initial')
const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110, source: 'provider' as const, uncertain: false }
const report = (target: string) => `\`\`\`json\n${JSON.stringify({ status: 'done', summary: `wrote ${target}`, uncertainties: [], sources: [{ path: target }] })}\n\`\`\``
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const writes = new Map<string, [string, string]>()
if (fixtureId === 'single-repair') {
  writes.set('st-1', ['src/cart.mjs', await readFixtureFile('repair', 'reference/src/cart.mjs')])
} else {
  writes.set('st-1', ['packages/normalize/src/name.mjs', await readFixtureFile('normalize', 'reference/src/name.mjs')])
  writes.set('st-2', ['packages/dedupe/src/unique.mjs', await readFixtureFile('dedupe', 'reference/src/unique.mjs')])
  writes.set('st-3', ['packages/report/src/report.mjs', await fs.readFile(reportReference, 'utf8')])
}
const plan: PlanInput = fixturePlan(fixtureId)
let calls = 0, plannerCalls = 0, toolSequence = 0
const adapter = {
  provider: 'scripted', model: 'demo', capabilities: { demo: { contextWindowTokens: 100_000 } },
  chat: async (request: ChatRequest): Promise<ChatResponse> => {
    calls++
    const text = (request.messages ?? []).map(message => typeof message.content === 'string' ? message.content : '').join('\n')
    if (text.includes('Plan the root goal below')) {
      plannerCalls++
      return { usage, content: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``, complete: true, finishReason: 'stop' }
    }
    const id = /Subtask (st-\d+)/.exec(text)?.[1]
    assert.ok(id && writes.has(id), `unexpected worker prompt for ${String(id)}`)
    const [target, content] = writes.get(id)!
    const hasTool = (request.messages ?? []).some(message => message.role === 'tool')
    if (!hasTool) {
      // 第一波的两个 worker 同时到达模型调用，演示日志里才能看到 started/finished 区间重叠。
      if (id !== 'st-3') await delay(200)
      return { usage, toolCalls: [{ id: `write-${++toolSequence}`, name: 'write_file', arguments: { path: target, content } }] }
    }
    return { usage, content: report(target), complete: true, finishReason: 'stop' }
  },
}

console.log(`demo orchestrate-${mode} (offline scripted model; provider requests=0)`)
try {
  const result = await orchestrate({
    repository: repo, goal: fixture.goal, baseDirectory, adapter, model: 'scripted/demo',
    maxWorkers: mode === 'parallel' ? 2 : 1, approval: { writes: 'auto', bash: 'ask', approve: async () => true },
  })
  assert.equal(result.status, 'completed', result.error)
  const reportState = await loadOrchestration(result.directory)
  assert.equal(reportState.state.plan?.source, 'model')
  assert.equal(reportState.state.decision?.mode, mode === 'parallel' ? 'parallel' : 'single')
  assert.equal(plannerCalls, 1)
  console.log(`1. planner (read-only) returned a ${reportState.state.decision!.mode} plan: ${reportState.state.decision!.reason}`)

  const attempts = reportState.state.attemptOrder.map(id => reportState.state.attempts[id]!)
  if (mode === 'parallel') {
    assert.deepEqual(reportState.state.decision?.waves, [['st-1', 'st-2'], ['st-3']])
    const started = (attemptId: string) => reportState.events.find(event => event.type === 'attempt/started' && event.data.attemptId === attemptId)!.at
    const finished = (attemptId: string) => reportState.events.find(event => event.type === 'attempt/finished' && event.data.attemptId === attemptId)!.at
    const [first, second] = attempts.filter(attempt => attempt.wave === 0)
    assert.ok(Date.parse(started(first!.attemptId)) < Date.parse(finished(second!.attemptId)))
    assert.ok(Date.parse(started(second!.attemptId)) < Date.parse(finished(first!.attemptId)))
    const applied = reportState.state.integrations.flatMap(integration => integration.applied.map(item => reportState.state.attempts[item.attemptId]!.subtaskId))
    assert.deepEqual(applied, ['st-1', 'st-2', 'st-3'])
    const dependent = attempts.find(attempt => attempt.wave === 1)!
    assert.equal(attempts.filter(attempt => attempt.wave === 1).length, 1)
    // 第二波 worker 的 worktree 以整合 head 为基线：它确实能看到第一波已整合的参考实现。
    assert.match(await fs.readFile(path.join(dependent.worktree!, 'packages/normalize/src/name.mjs'), 'utf8'), /toLowerCase/)
    assert.match(await fs.readFile(path.join(dependent.worktree!, 'packages/dedupe/src/unique.mjs'), 'utf8'), /new Set/)
    console.log('2. wave 1: st-1 and st-2 overlap; their attempts are integrated before wave 2 starts')
    console.log('3. wave 2: st-3 ran on the integrated head with both dependency commits available')
  } else {
    assert.equal(attempts.length, 1)
    assert.equal(reportState.state.integrations[0]?.applied.length, 1)
    console.log('2. one worker ran the whole change; the host committed, integrated and verified it')
  }

  const integration = path.join(result.directory, 'worktrees', 'integration')
  const hidden = await evaluateOrchestrationFixture(fixtureId, integration)
  assert.equal(hidden.passed, true, hidden.results.map(item => `${item.taskId}: ${item.output}`).join('\n'))
  console.log(`4. hidden verifier passed ${hidden.results.length}/${hidden.results.length}: ${hidden.results.map(item => item.taskId).join(', ')}`)
  assert.ok(reportState.state.verifications.every(verification => verification.exitCode === 0))
  assert.equal(await headCommit(repo), baseCommit)
  assert.deepEqual(await statusPorcelain(repo), [])

  const plannerFile = reportState.state.plan?.plannerSessionId
    ? path.join(result.directory, 'sessions', 'planner', reportState.state.plan.plannerSessionId, 'events.jsonl')
    : undefined
  const plannerReport = plannerFile ? await inspectSession(plannerFile) : undefined
  console.log(`\nplanner overhead: requests=${plannerReport?.requests.main ?? 0} tokens=${plannerReport ? plannerReport.providerUsage.inputTokens + plannerReport.providerUsage.outputTokens : 0}`)
  console.log(`\n${formatOrchestration({ ...reportState, events: reportState.events.length })}`)
  console.log(`\ndemo orchestrate-${mode}: PASS; scripted provider requests=${calls}; user worktree unchanged; temp workspace removed`)
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
