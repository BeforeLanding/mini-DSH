import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChatRequest, ChatResponse, ToolCall } from '../src/core/contracts.js'
import { commitAll, git, headCommit, stageAll, statusPorcelain } from '../src/orchestration/git.js'
import { orchestrate } from '../src/orchestration/orchestrator.js'
import { loadOrchestration } from '../src/orchestration/inspect.js'
import type { PlanInput } from '../src/orchestration/contracts.js'

const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110, source: 'provider' as const, uncertain: false }
const plan: PlanInput = {
  version: 1, rationale: 'two independent files in one wave',
  subtasks: [
    { id: 'st-1', title: 'write a', objective: 'create src/a.txt', writeSet: ['src/a.txt'], acceptance: { commands: ['node check-a.mjs'] } },
    { id: 'st-2', title: 'write b', objective: 'create src/b.txt', writeSet: ['src/b.txt'], acceptance: { commands: ['node check-b.mjs'] } },
  ],
}
let nextCall = 0
const write = (target: string, content: string): ToolCall => ({ id: `stop-call-${++nextCall}`, name: 'write_file', arguments: { path: target, content } })
const report = (target: string) => `\`\`\`json\n${JSON.stringify({ status: 'done', summary: `wrote ${target}`, uncertainties: [], sources: [{ path: target }] })}\n\`\`\``
async function repository(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-stop-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const repo = path.join(root, 'repo')
  await fs.mkdir(repo)
  await git(repo, ['init', '--quiet'])
  await git(repo, ['config', 'core.autocrlf', 'false'])
  for (const name of ['a', 'b'])
    await fs.writeFile(path.join(repo, `check-${name}.mjs`), `import fs from 'node:fs'\nconst text = fs.readFileSync(new URL('./src/${name}.txt', import.meta.url), 'utf8')\nif (text !== '${name}\\n') { console.error('FAIL'); process.exit(1) }\nconsole.log('PASS')\n`)
  await fs.writeFile(path.join(repo, 'base.txt'), 'base\n')
  await stageAll(repo)
  const baseCommit = await commitAll(repo, 'initial')
  return { root, repo, baseCommit, baseDirectory: path.join(root, 'orch') }
}
function adapter(input: { block: 'st-1'; onBlocked: () => void; release?: Promise<void>; ignoreSignal?: boolean }) {
  return {
    provider: 'scripted', model: 'test', capabilities: { test: { contextWindowTokens: 100_000 } },
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      const text = (request.messages ?? []).map(message => typeof message.content === 'string' ? message.content : '').join('\n')
      const id = text.includes('Subtask st-2') ? 'st-2' : 'st-1'
      const target = id === 'st-1' ? 'src/a.txt' : 'src/b.txt', content = id === 'st-1' ? 'a\n' : 'b\n'
      const hasTool = (request.messages ?? []).some(message => message.role === 'tool')
      if (!hasTool) {
        if (id === input.block) {
          input.onBlocked()
          if (input.ignoreSignal) await new Promise<void>(() => {})
          else await new Promise<void>((resolve, reject) => {
            const abort = () => reject(new Error('cancelled'))
            if (request.signal?.aborted) return abort()
            request.signal?.addEventListener('abort', abort, { once: true })
            void input.release?.then(() => { request.signal?.removeEventListener('abort', abort); resolve() })
          })
        }
        return { usage, toolCalls: [write(target, content)], complete: true }
      }
      return { usage, content: report(target), complete: true, finishReason: 'stop' }
    },
  }
}
function run(repo: string, baseDirectory: string, model: ReturnType<typeof adapter>, extra: Record<string, unknown> = {}) {
  return orchestrate({
    repository: repo, goal: 'write both files', plan, baseDirectory, adapter: model, model: 'scripted/test',
    maxWorkers: 1, approval: { writes: 'auto', bash: 'ask', approve: async () => true }, ...extra,
  })
}

test('the first Ctrl-C stops dispatching, lets the running attempt finish and integrates the result', async t => {
  const { repo, baseCommit, baseDirectory } = await repository(t)
  const dispatch = new AbortController()
  let blocked!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { blocked = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const running = run(repo, baseDirectory, adapter({ block: 'st-1', onBlocked: blocked, release: released }), { dispatchSignal: dispatch.signal })
  await entered
  dispatch.abort()
  release()
  const result = await running
  assert.equal(result.status, 'partial', result.error)
  const report = await loadOrchestration(result.directory)
  const stop = report.events.find(event => event.type === 'control/stop')
  assert.equal(stop?.type === 'control/stop' && stop.data.scope, 'dispatch')
  const attempts = report.state.attemptOrder.map(id => report.state.attempts[id]!)
  assert.equal(attempts.find(item => item.subtaskId === 'st-1')?.outcome, 'succeeded')
  assert.equal(attempts.find(item => item.subtaskId === 'st-2')?.outcome, 'skipped')
  assert.equal(report.state.integrations[0]?.status, 'finished')
  assert.equal(report.state.verifications[0]?.exitCode, 0)
  assert.equal(report.state.finished?.status, 'partial')
  assert.equal(await headCommit(repo), baseCommit)
  assert.deepEqual(await statusPorcelain(repo), [])
})

test('the second Ctrl-C aborts the running attempt, refuses integration and finishes cancelled', async t => {
  const { repo, baseCommit, baseDirectory } = await repository(t)
  const running = new AbortController()
  let blocked!: () => void
  const entered = new Promise<void>(resolve => { blocked = resolve })
  const attempt = run(repo, baseDirectory, adapter({ block: 'st-1', onBlocked: blocked, ignoreSignal: true }), { signal: running.signal })
  await entered
  running.abort()
  const result = await attempt
  assert.equal(result.status, 'cancelled')
  const report = await loadOrchestration(result.directory)
  const stop = report.events.find(event => event.type === 'control/stop')
  assert.equal(stop?.type === 'control/stop' && stop.data.scope, 'running')
  const attempts = report.state.attemptOrder.map(id => report.state.attempts[id]!)
  assert.equal(attempts.find(item => item.subtaskId === 'st-1')?.outcome, 'cancelled')
  assert.equal(report.state.integrations.length, 0)
  assert.equal(report.state.verifications.length, 0)
  assert.equal(report.state.finished?.status, 'cancelled')
  assert.equal(await headCommit(repo), baseCommit)
})

test('the root wall deadline stops running attempts through the injected clock', async t => {
  const { repo, baseDirectory } = await repository(t)
  let now = 1_000_000
  let blocked!: () => void
  const entered = new Promise<void>(resolve => { blocked = resolve })
  const attempt = run(repo, baseDirectory, adapter({ block: 'st-1', onBlocked: blocked, ignoreSignal: true }), {
    clock: () => now, rootBudget: { maxWallMs: 60_000 },
  })
  await entered
  now += 120_000
  const result = await attempt
  assert.equal(result.status, 'cancelled')
  const report = await loadOrchestration(result.directory)
  const stop = report.events.find(event => event.type === 'control/stop')
  assert.equal(stop?.type === 'control/stop' && stop.data.scope, 'running')
  assert.match(stop?.type === 'control/stop' ? stop.data.reason : '', /wall deadline/)
  assert.equal(report.state.finished?.status, 'cancelled')
  assert.equal(report.state.integrations.length, 0)
})
