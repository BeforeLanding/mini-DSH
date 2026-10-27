import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prepareMemoryTeamManifests, validateMemoryTeamManifests } from '../scripts/eval-memory-team.js'
import type { MemoryTeamManifest } from '../scripts/eval-memory-team.js'
import { MEMORY_TEAM_ARMS, loadMemoryTeamData } from '../scripts/memory-team-eval-plan.js'
import { PREPARE_PROMPT, createFrozenMemorySnapshot, materializeWorkflowWorkspace, runMemoryTeamEpisode } from '../scripts/memory-team-executor.js'
import type { EpisodeAdapter } from '../scripts/memory-team-executor.js'
import { verifyMemoryTeamWorkflow } from '../scripts/memory-team-verifier.js'
import { memoryHash } from '../src/core/memory-contracts.js'

function seal(manifest: MemoryTeamManifest) { const { digest: _digest, ...body } = manifest; return { ...body, digest: memoryHash(JSON.stringify(body)) } }

test('memory/team development protocol validates four actual Harness configurations and all 16 zero-model episodes', async () => {
  const manifests = await prepareMemoryTeamManifests(), report = await validateMemoryTeamManifests(manifests)
  assert.equal(report.valid, true); assert.equal(report.providerCalls, 0); assert.equal(report.plannedDevelopmentEpisodes, 16); assert.equal(report.dryRunEpisodes, 16)
  assert.ok(manifests.every(manifest => manifest.postCompactionPrune === false && manifest.runBudget.postCompactionPrune === false && !manifest.paidExecutionAuthorized))
  assert.ok(manifests.every(manifest => manifest.amount.perEpisodeUsd > 0 && manifest.amount.batchUsd >= manifest.amount.perEpisodeUsd * 16))
  assert.deepEqual(manifests.map(manifest => [manifest.memory, manifest.team]), [[false, false], [true, false], [false, true], [true, true]])
  assert.equal(new Set(manifests[0]!.episodes.map(episode => episode.id)).size, 16)
})

test('development protocol rejects mismatched budgets, forged/stale provenance, duplicated arms and paid or formal claims', async () => {
  const manifests = await prepareMemoryTeamManifests()
  const mismatch = structuredClone(manifests); mismatch[1]!.taskGroupPolicy.maxTotalTokens++
  await assert.rejects(validateMemoryTeamManifests(mismatch, { dryRun: false }), /must match/)
  const paid = manifests.map(manifest => seal({ ...manifest, paidExecutionAuthorized: true as false }))
  await assert.rejects(validateMemoryTeamManifests(paid, { dryRun: false }), /paid-run authorization/)
  const stale = manifests.map(manifest => seal({ ...manifest, source: { ...manifest.source, codeDigest: 'f'.repeat(64) } }))
  await assert.rejects(validateMemoryTeamManifests(stale, { dryRun: false }), /invalid, stale or mismatched/)
  await assert.rejects(validateMemoryTeamManifests([manifests[0]!, manifests[0]!, manifests[2]!, manifests[3]!], { dryRun: false }), /four independent/)
  const formal = manifests.map(manifest => seal({ ...manifest, phase: 'formal' as 'development' }))
  await assert.rejects(validateMemoryTeamManifests(formal, { dryRun: false }), /invalid, stale or mismatched/)
  const invalidBudget = manifests.map(manifest => seal({ ...manifest, taskGroupPolicy: { ...manifest.taskGroupPolicy, maxTotalTokens: -1 } }))
  await assert.rejects(validateMemoryTeamManifests(invalidBudget, { dryRun: false }), /budget mismatch/)
  const changedSchedule = manifests.map(manifest => seal({ ...manifest, episodes: manifest.episodes.slice(1) }))
  await assert.rejects(validateMemoryTeamManifests(changedSchedule, { dryRun: false }), /must match|schedule/)
})

test('verifier rejects protected-file changes, unexpected files and missing objective fields', async () => {
  const data = await loadMemoryTeamData()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-team-verifier-'))
  try {
    for (const workflow of data.workflows) {
      const workspace = path.join(root, workflow.id)
      await materializeWorkflowWorkspace(workflow, data, workspace)
      const untouched = await verifyMemoryTeamWorkflow(workflow, workspace)
      assert.equal(untouched.passed, false)
      assert.ok(untouched.checks.some(check => check.id === 'answer-json' && !check.passed))
      if (workflow.id === 'W02') {
        await fs.writeFile(path.join(workspace, 'docs/ENTRY.md'), workflow.targetFiles['docs/ENTRY.md']!, 'utf8')
        await fs.writeFile(path.join(workspace, 'answer.json'), JSON.stringify({ currentEntry: 'src/new.mjs', historicalApplicable: false }))
        await fs.writeFile(path.join(workspace, 'UNEXPECTED.md'), 'not allowed')
        const extra = await verifyMemoryTeamWorkflow(workflow, workspace)
        assert.equal(extra.passed, false)
        assert.deepEqual(extra.unexpectedFiles, ['UNEXPECTED.md'])
        await fs.rm(path.join(workspace, 'UNEXPECTED.md'))
        await fs.writeFile(path.join(workspace, 'src/old.mjs'), 'tampered\n')
        const changed = await verifyMemoryTeamWorkflow(workflow, workspace)
        assert.equal(changed.passed, false)
        assert.deepEqual(changed.protectedFilesChanged, ['src/old.mjs'])
      }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('two-phase executor runs prepare and goal, verifies independently and accounts both phases for every arm', async () => {
  const data = await loadMemoryTeamData(), manifests = await prepareMemoryTeamManifests()
  const workflow = data.workflows.find(item => item.id === 'W01')!
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-team-executor-'))
  const snapshotDirectory = path.join(root, 'snapshot')
  await createFrozenMemorySnapshot(data.memorySnapshot, snapshotDirectory)
  const answers: Record<string, unknown> = { W01: { verificationPath: 'docs/VERIFY.md', verificationCommand: 'node check.mjs', sourcePath: 'src/value.mjs' } }
  const makeAdapter = (workflowId: string): EpisodeAdapter => {
    let prepareCalls = 0, goalCalls = 0
    return {
      provider: 'scripted', model: 'scripted',
      async chat(request) {
        const lastUser = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')?.content
        const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110, source: 'provider' as const, uncertain: false, cacheReadTokens: 0 }
        const tool = (id: string, name: string, args: Record<string, unknown>) => ({
          content: '', complete: true, finishReason: 'tool_calls', usage,
          toolCalls: [{ id, name, arguments: args }],
        })
        if (lastUser === PREPARE_PROMPT) {
          prepareCalls += 1
          if (prepareCalls === 1) return tool('prep-1', 'write_file', { path: 'PREPARE.md', content: 'verified preparation\n' })
          return { content: 'prepared', complete: true, finishReason: 'stop', usage, toolCalls: [] }
        }
        goalCalls += 1
        if (goalCalls === 1) return tool('goal-1', 'write_file', { path: 'answer.json', content: JSON.stringify(answers[workflowId]) + '\n' })
        return { content: 'done', complete: true, finishReason: 'stop', usage, toolCalls: [] }
      },
    }
  }
  try {
    for (const arm of MEMORY_TEAM_ARMS) {
      const manifest = manifests.find(item => item.arm === arm)!
      const result = await runMemoryTeamEpisode({
        episode: { id: `W01-${arm}`, workflowId: 'W01', arm, block: 0 }, workflow, data, manifest,
        adapter: makeAdapter('W01'), episodeRoot: path.join(root, arm), memorySnapshotDirectory: snapshotDirectory,
      })
      assert.equal(result.acceptance.passed, true, `${arm} acceptance: ${JSON.stringify(result.acceptance.checks)}`)
      assert.equal(result.reliableCompletion, true, `${arm} status ${result.status} ${result.error ?? ''}`)
      assert.deepEqual(result.phases.map(phase => phase.phase), ['prepare', 'goal'])
      assert.ok(result.phases.every(phase => phase.status === 'completed'))
      assert.equal(result.accounting.modelRequests, 4)
      assert.equal(result.accounting.total.totalTokens, 440)
      assert.equal(result.accounting.phases.find(phase => phase.phase === 'prepare')!.total.totalTokens, 220)
      assert.equal(result.accounting.phases.find(phase => phase.phase === 'goal')!.total.totalTokens, 220)
      assert.equal(result.accounting.memory.viewEvents, arm.endsWith('memory-on') ? 2 : 0)
      assert.equal(result.accounting.summary.totalTokens, 0)
      assert.equal(result.accounting.child.totalTokens, 0)
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('accounting separates prepare, goal, root, summary, child, retry, memory and delegation usage', async () => {
  const { deriveMemoryTeamAccounting } = await import('../scripts/memory-team-stats.js')
  let seq = 0
  const event = (type: string, data: unknown, taskId?: string, sessionId = 'root') => ({ version: 1, sessionId, id: `e${++seq}`, seq, ...(taskId ? { taskId } : {}), type, data, at: '2026-10-27T00:00:00.000Z' }) as never
  const usage = (input: number, output: number) => ({ inputTokens: input, outputTokens: output, totalTokens: input + output, source: 'provider', uncertain: false, cacheReadTokens: 0 })
  const reserve = (requestId: string, root: boolean, purpose: 'main' | 'summary', taskId: string) => event('group/budget-reserved', { requestId, root, purpose, reserve: 1, agentId: 'a', sessionId: 's', runId: 'r' }, taskId)
  const settle = (requestId: string, input: number, output: number) => event('group/budget-settled', { requestId, usage: usage(input, output), overrun: false })
  const rootEvents = [
    event('run/start', { state: { taskId: 'prepare-task', runId: 'r1' } }, 'prepare-task'),
    event('run/start', { state: { taskId: 'goal-task', runId: 'r2' } }, 'goal-task'),
    reserve('p-root', true, 'main', 'prepare-task'), settle('p-root', 60, 40), event('model/start', {}, 'prepare-task'),
    reserve('g-root', true, 'main', 'goal-task'), settle('g-root', 120, 80), event('model/start', {}, 'goal-task'),
    reserve('g-summary', true, 'summary', 'goal-task'), settle('g-summary', 30, 20), event('model/start', {}, 'goal-task'),
    reserve('g-child', false, 'main', 'goal-task'), settle('g-child', 20, 10),
    reserve('g-retry', true, 'main', 'goal-task'), settle('g-retry', 30, 10), event('model/retry', { failedRequestId: 'g-retry', rootRequestId: 'g-root' }, 'goal-task'),
    event('tool/start', {}, 'prepare-task'), event('tool/start', {}, 'goal-task'), event('tool/start', {}, 'goal-task'),
    event('memory/query', { items: [{ id: 'a', revision: 1 }, { id: 'b', revision: 1 }], filtered: { 'anchor-changed': 1 } }, 'goal-task'),
    event('context/summary-end', { outcome: { kind: 'applied' } }, 'goal-task'),
    event('delegation/start', { children: [{}, {}] }, 'goal-task'),
    event('delegation/child-created', { childSessionId: 'child-session' }, 'goal-task'),
    event('delegation/child-finish', { status: 'completed' }, 'goal-task'),
    event('run/finish', { state: { taskId: 'prepare-task', counters: { activeDurationMs: 10 } } }, 'prepare-task'),
    event('run/finish', { state: { taskId: 'goal-task', counters: { activeDurationMs: 20 } } }, 'goal-task'),
  ]
  const childEvents = [[
    event('model/start', {}, 'child-task', 'child-session'), event('tool/start', {}, 'child-task', 'child-session'),
    event('run/finish', { state: { taskId: 'child-task', counters: { activeDurationMs: 7 } } }, 'child-task', 'child-session'),
  ]]
  const accounting = deriveMemoryTeamAccounting(rootEvents, childEvents, { inputPerMillion: 0.30, outputPerMillion: 1.20, cacheReadPerMillion: 0.006 })
  const prepare = accounting.phases.find(phase => phase.phase === 'prepare')!, goal = accounting.phases.find(phase => phase.phase === 'goal')!
  assert.equal(prepare.total.totalTokens, 100); assert.equal(prepare.root.totalTokens, 100)
  assert.equal(goal.total.totalTokens, 320); assert.equal(goal.root.totalTokens, 240); assert.equal(goal.summary.totalTokens, 50); assert.equal(goal.child.totalTokens, 30)
  assert.equal(accounting.total.totalTokens, 420); assert.equal(accounting.child.totalTokens, 30); assert.equal(accounting.summary.totalTokens, 50)
  assert.equal(accounting.retryRequests, 1); assert.equal(accounting.retryFailedTokens, 40); assert.ok(Math.abs(accounting.retryCostUsd - 0.000021) < 1e-12)
  assert.equal(accounting.tools, 4); assert.equal(accounting.modelRequests, 4)
  assert.equal(accounting.memory.queries, 1); assert.equal(accounting.memory.hits, 2); assert.equal(accounting.memory.filtered['anchor-changed'], 1)
  assert.equal(accounting.summaries.applied, 1); assert.equal(accounting.delegation.batches, 1); assert.equal(accounting.delegation.childSessions, 1)
  assert.equal(accounting.delegation.statuses.completed, 1); assert.equal(accounting.activeDurationMs, 37); assert.equal(accounting.childActiveDurationMs, 7)
})

test('episode amount guard refuses dispatch before spending beyond a hard cap', async () => {
  const { createEpisodeAmountGuard } = await import('../scripts/memory-team-executor.js')
  let calls = 0
  const guard = createEpisodeAmountGuard(async () => { calls += 1; return { content: 'ok', complete: true, usage: { inputTokens: 1_000, outputTokens: 1_000, totalTokens: 2_000, source: 'provider', uncertain: false } } }, {
    provider: 'p', model: 'm', maxModelRequests: 10, maxTotalTokens: 100_000, maxWallDurationMs: 60_000, maxUsd: 0.000001,
    price: { inputPerMillion: 0.30, outputPerMillion: 1.20, cacheReadPerMillion: 0.006 },
  })
  await assert.rejects(guard.adapter.chat({ messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 16_384 }), /amount cap/)
  assert.equal(calls, 0)
})

test('memory/team evaluation executable refuses the old live-run shortcut and advertises the explicit paid path', () => {
  const executable = fileURLToPath(new URL('../scripts/eval-memory-team.js', import.meta.url))
  const result = spawnSync(process.execPath, [executable, '--run', 'anything'], { encoding: 'utf8', windowsHide: true })
  assert.notEqual(result.status, 0); assert.match(result.stderr, /usage: eval-memory-team/)
  const paid = spawnSync(process.execPath, [executable, '--execute', 'missing', '--evidence-root', 'out', '--max-usd', '1'], { encoding: 'utf8', windowsHide: true })
  assert.notEqual(paid.status, 0)
})
