import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChatRequest, ChatResponse } from '../src/core/contracts.js'
import type { PlanInput } from '../src/orchestration/contracts.js'
import { commitAll, git, headCommit, stageAll, statusPorcelain } from '../src/orchestration/git.js'
import { crashAt } from '../src/orchestration/faults.js'
import { formatOrchestration, loadOrchestration } from '../src/orchestration/inspect.js'
import { orchestrate, resumeOrchestrate } from '../src/orchestration/orchestrator.js'

// 离线演示：脚本模型 + 真 git；不配置 provider，也不请求任何付费 API。
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-orch-crash-'))
const repo = path.join(root, 'repo'), baseDirectory = path.join(root, 'orchestrations')
await fs.mkdir(repo)
await git(repo, ['init', '--quiet'])
await git(repo, ['config', 'core.autocrlf', 'false'])
for (const name of ['a', 'b'])
  await fs.writeFile(path.join(repo, `check-${name}.mjs`), `import fs from 'node:fs'\nconst text = fs.readFileSync(new URL('./src/${name}.txt', import.meta.url), 'utf8')\nif (text !== '${name}\\n') { console.error('FAIL'); process.exit(1) }\nconsole.log('PASS')\n`)
await fs.writeFile(path.join(repo, 'base.txt'), 'base\n')
await stageAll(repo)
const baseCommit = await commitAll(repo, 'initial')
const plan: PlanInput = {
  version: 1, rationale: 'two independent files, one worker is interrupted',
  subtasks: [
    { id: 'st-1', title: 'write a', objective: 'create src/a.txt', writeSet: ['src/a.txt'], acceptance: { commands: ['node check-a.mjs'] } },
    { id: 'st-2', title: 'write b', objective: 'create src/b.txt', writeSet: ['src/b.txt'], acceptance: { commands: ['node check-b.mjs'] } },
  ],
}
const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110, source: 'provider' as const, uncertain: false }
const report = (target: string) => `\`\`\`json\n${JSON.stringify({ status: 'done', summary: `wrote ${target}`, uncertainties: [], sources: [{ path: target }] })}\n\`\`\``
let calls = 0, st2Runs = 0, toolSequence = 0, st2Blocked = false
let sideEffectDone!: () => void
const sideEffectDonePromise = new Promise<void>(resolve => { sideEffectDone = resolve })
const writes: Record<string, [string, string]> = { 'st-1': ['src/a.txt', 'a\n'], 'st-2': ['src/b.txt', 'b\n'] }
const adapter = {
  provider: 'scripted', model: 'demo', capabilities: { demo: { contextWindowTokens: 100_000 } },
  chat: async (request: ChatRequest): Promise<ChatResponse> => {
    calls++
    const text = (request.messages ?? []).map(message => typeof message.content === 'string' ? message.content : '').join('\n')
    const id = text.includes('Subtask st-2') ? 'st-2' : 'st-1'
    const hasTool = (request.messages ?? []).some(message => message.role === 'tool')
    const [target, content] = writes[id]!
    if (id === 'st-2' && !hasTool) {
      st2Runs++
      if (st2Runs === 1) {
        // 第一次尝试：先执行一个 Bash（外部副作用），下一次模型调用会一直在途。
        return { usage, toolCalls: [{ id: `bash-${++toolSequence}`, name: 'bash', arguments: { command: 'echo side-effect' } }] }
      }
      return { usage, toolCalls: [{ id: `write-${++toolSequence}`, name: 'write_file', arguments: { path: target, content } }] }
    }
    if (id === 'st-2' && hasTool) {
      if (!st2Blocked) {
        // Bash 已执行；这次 provider 调用在崩溃时仍未返回，形成未知用量。
        st2Blocked = true
        sideEffectDone()
        await new Promise<void>(() => {})
      }
      return { usage, content: report(target), complete: true, finishReason: 'stop' }
    }
    if (id === 'st-1' && hasTool) {
      // 等 st-2 的副作用完成并进入下一次模型调用后再让 st-1 完成。
      await sideEffectDonePromise
      await new Promise(resolve => setTimeout(resolve, 300))
      return { usage, content: report(target), complete: true, finishReason: 'stop' }
    }
    return { usage, toolCalls: [{ id: `write-${++toolSequence}`, name: 'write_file', arguments: { path: target, content } }] }
  },
}
const approval = { writes: 'auto' as const, bash: 'auto' as const, approve: async () => true }
const runOptions = {
  repository: repo, goal: 'write both files', plan, baseDirectory, adapter, model: 'scripted/demo',
  maxWorkers: 2, approval,
}
console.log('demo orchestrate-crash (offline scripted model; provider requests=0)')
try {
  const crashed = await orchestrate({ ...runOptions, faults: crashAt('after-worker-run') })
  const crashes = await loadOrchestration(crashed.directory)
  assert.equal(crashes.state.finished, undefined)
  const callsAtCrash = calls
  console.log(`1. simulated crash while st-1 finishes and st-2 is in flight: ${crashed.error}`)
  console.log(`   attempts: ${crashes.state.attemptOrder.map(id => `${crashes.state.attempts[id]!.subtaskId}=${crashes.state.attempts[id]!.status}`).join(', ')}`)
  const refused = await resumeOrchestrate({ ...runOptions, rootId: crashed.rootId })
  assert.equal(refused.status, 'needs_human')
  const refusedState = await loadOrchestration(refused.directory)
  assert.ok(Object.values(refusedState.state.ledger.reservations).some(item => item.status === 'unknown' && item.cause === 'crash'))
  console.log('2. resume without confirmation: unknown crash usage keeps the root at needs_human')
  const accepted = await resumeOrchestrate({ ...runOptions, rootId: crashed.rootId, acceptUnknownUsage: true })
  assert.equal(accepted.status, 'needs_human')
  const acceptedState = await loadOrchestration(accepted.directory)
  const interrupted = acceptedState.state.attemptOrder.map(id => acceptedState.state.attempts[id]!).find(item => item.status === 'interrupted')
  assert.equal(interrupted?.unknownSideEffects, true)
  const adopted = acceptedState.state.attemptOrder.map(id => acceptedState.state.attempts[id]!).find(item => item.subtaskId === 'st-1')
  assert.equal(adopted?.outcome, 'succeeded')
  assert.equal(calls, callsAtCrash, 'the completed worker must not be re-executed')
  console.log('3. confirmed unknown usage: st-1 is adopted, st-2 needs a human decision')
  const retried = await resumeOrchestrate({ ...runOptions, rootId: crashed.rootId, acceptUnknownUsage: true, retry: ['st-2'] })
  assert.equal(retried.status, 'completed', retried.error)
  const final = await loadOrchestration(retried.directory)
  assert.equal(final.state.finished?.status, 'completed')
  assert.equal(final.state.attempts[interrupted!.attemptId]?.outcome, 'interrupted')
  assert.equal(final.state.verifications[0]?.exitCode, 0)
  assert.equal(await headCommit(repo), baseCommit)
  assert.deepEqual(await statusPorcelain(repo), [])
  console.log('4. retried st-2 in a new epoch; integration and verification completed')
  console.log(`\n${formatOrchestration({ ...final, events: final.events.length })}`)
  console.log(`\ndemo orchestrate-crash: PASS; scripted provider requests=${calls}; user worktree unchanged; temp workspace removed`)
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
