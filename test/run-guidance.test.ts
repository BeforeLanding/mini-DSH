import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveBudget } from '../src/core/budget.js'
import type { BudgetPolicy } from '../src/core/budget.js'
import type { Adapter, ChatRequest, ChatResponse, SessionEvent } from '../src/core/contracts.js'
import { maskedObservationCount, maskObservations, observationStub, OBSERVATION_MARKER } from '../src/core/observation-mask.js'
import { BUDGET_NOTICE_PREFIX, COMPLETION_CHECK_PREFIX, completionCheck } from '../src/core/run-guidance.js'
import { renderCommandText } from '../src/plugins/tool-results.js'
import type { CommandResult } from '../src/core/command-runner.js'
import { harness } from './harness.js'

const policy = (overrides: BudgetPolicy = {}): BudgetPolicy => ({ contextWindowTokens: 1_000_000, maxOutputTokens: 1000, minimumOutputTokens: 1, ...overrides })
const text = (request: ChatRequest) => (request.messages ?? []).map(message => String(message.content ?? '')).join('\n')

function scripted(toolSteps: number, finals: string[] = ['done'], usage?: (call: number) => ChatResponse['usage']) {
  const requests: ChatRequest[] = []
  let call = 0
  return {
    requests,
    chat: (async (request: ChatRequest): Promise<ChatResponse> => {
      requests.push(request)
      call += 1
      const extra = usage ? { usage: usage(call) } : {}
      if (call <= toolSteps) return { toolCalls: [{ id: `call-${call}`, name: 'probe', arguments: { n: call } }], ...extra }
      return { content: finals.shift() ?? 'done', ...extra }
    }) as Adapter['chat'],
  }
}

test('new budget keys are opt-in and validated', () => {
  assert.equal(resolveBudget({}).observationWindow, undefined)
  assert.equal(resolveBudget({}).budgetNotices, undefined)
  assert.equal(resolveBudget({}).completionChecks, undefined)
  assert.equal(resolveBudget({ observationWindow: 6, budgetNotices: true, completionChecks: true }).observationWindow, 6)
  assert.throws(() => resolveBudget({ observationWindow: 0 }), /positive/)
  assert.throws(() => resolveBudget({ observationStep: 0 }), /positive/)
  assert.equal(resolveBudget({ observationWindow: 4, observationStep: 8 }).observationStep, 8)
  assert.throws(() => resolveBudget({ budgetNotices: 1 as unknown as boolean }), /boolean/)
})

test('observation masking advances in blocks and keeps short outputs verbatim', () => {
  assert.equal(maskedObservationCount(4, 4), 0)
  assert.equal(maskedObservationCount(5, 4), 0)
  assert.equal(maskedObservationCount(6, 4), 2)
  assert.equal(maskedObservationCount(7, 4), 2)
  assert.equal(maskedObservationCount(8, 4), 4)
  // 显式步长：窗口 4、步长 8 时，到第 12 条才第一次遮蔽 8 条。
  assert.equal(maskedObservationCount(11, 4, 8), 0)
  assert.equal(maskedObservationCount(12, 4, 8), 8)
  assert.equal(maskedObservationCount(19, 4, 8), 8)
  assert.equal(maskedObservationCount(20, 4, 8), 16)
  assert.equal(observationStub('short', 3), 'short')
  const stub = observationStub(`${'line\n'.repeat(400)}`, 17)
  assert.ok(stub.length < 500)
  assert.match(stub, /read_history with from=17/)
})

test('masking rewrites only old current-task tool results in the projection; the log keeps the originals', async () => {
  const run = scripted(10)
  const h = harness(run.chat)
  h.tools.register({ name: 'probe', execute: (args: { n: number }) => `output-${args.n}\n${'x'.repeat(2000)}` })
  assert.equal(await h.agent.send('investigate', { budget: policy({ observationWindow: 4 }) }), 'done')
  const last = text(run.requests.at(-1)!)
  const toolMessages = (run.requests.at(-1)!.messages ?? []).filter(message => message.role === 'tool').map(message => String(message.content))
  assert.equal(toolMessages.length, 10, 'tool protocol keeps every result message')
  toolMessages.forEach((content, index) => {
    assert.ok(content.startsWith(`output-${index + 1}\n`))
    assert.equal(content.includes(OBSERVATION_MARKER), index < 6, `output ${index + 1}: only the oldest six are stubs`)
  })
  const events = h.sessions.visibleEvents(h.session.id)
  const results = events.filter(event => event.type === 'tool/result')
  assert.equal(results.length, 10)
  assert.ok(results.every(event => event.type === 'tool/result' && !event.data.content.includes(OBSERVATION_MARKER)), 'raw events are not rewritten')
  const projections = events.flatMap(event => event.type === 'context/projection' ? [event.data] : [])
  assert.equal(projections.at(-1)!.maskedObservations, 6)
  assert.equal(projections[0]!.maskedObservations, undefined)
  // 同一条件下关闭窗口：不遮蔽，最后一次请求带着全部正文。
  const plain = scripted(10)
  const h2 = harness(plain.chat)
  h2.tools.register({ name: 'probe', execute: (args: { n: number }) => `output-${args.n}\n${'x'.repeat(2000)}` })
  await h2.agent.send('investigate', { budget: policy() })
  assert.ok(!text(plain.requests.at(-1)!).includes(OBSERVATION_MARKER))
  assert.ok(text(plain.requests.at(-1)!).length > last.length + 8_000, "six 2 KB outputs shrink to stubs")
})

test('masking never touches other tasks or non-tool events', () => {
  const event = (seq: number, taskId: string, content: string): SessionEvent => ({ version: 1, sessionId: 's', id: `e${seq}`, seq, taskId, type: 'tool/result', data: { toolCallId: `c${seq}`, content }, at: '' }) as SessionEvent
  const events = [1, 2, 3, 4, 5, 6].map(seq => event(seq, seq === 1 ? 'old' : 'current', 'y'.repeat(1000)))
  const { events: projected, masked } = maskObservations(events, 'current', 2)
  // 当前 task 5 条、窗口 2、步长 1：遮蔽最早 3 条，保留最近 2 条，另一 task 的不动。
  assert.equal(masked, 3)
  assert.equal(projected[0], events[0], 'other task untouched')
  for (const index of [1, 2, 3]) assert.ok((projected[index] as Extract<SessionEvent, { type: 'tool/result' }>).data.content.includes(OBSERVATION_MARKER))
  assert.equal(projected[4], events[4])
  assert.equal(projected[5], events[5])
})

test('budget notices fire once per level, skip to the highest crossed level, and are off by default', async () => {
  // 上限 100,000：前两次各 10,000（20%），第三次 60,000（80%，跳过 50% 只发 75），第四次 10,000（90%）。
  const sizes = [10_000, 10_000, 60_000, 10_000, 1_000]
  const usage = (call: number) => ({ inputTokens: sizes[call - 1]! - 100, outputTokens: 100, totalTokens: sizes[call - 1]!, source: 'provider' as const, uncertain: false })
  const run = scripted(4, ['done'], usage)
  const h = harness(run.chat)
  h.tools.register({ name: 'probe', execute: () => 'ok' })
  assert.equal(await h.agent.send('go', { budget: policy({ maxTotalTokens: 100_000, budgetNotices: true }) }), 'done')
  const notices = h.sessions.visibleEvents(h.session.id).flatMap(event => event.type === 'user/message' && event.data.content.startsWith(BUDGET_NOTICE_PREFIX) ? [event.data.content] : [])
  assert.deepEqual(notices.map(content => /level=(\d+)/.exec(content)![1]), ['75', '90'])
  assert.match(text(run.requests[3]!), /level=75/)
  assert.match(notices[1]!, /Finish now/)
  const off = scripted(4, ['done'], usage)
  const h2 = harness(off.chat)
  h2.tools.register({ name: 'probe', execute: () => 'ok' })
  await h2.agent.send('go', { budget: policy({ maxTotalTokens: 100_000 }) })
  assert.ok(!h2.sessions.visibleEvents(h2.session.id).some(event => event.type === 'user/message' && event.data.content.startsWith(BUDGET_NOTICE_PREFIX)))
})

test('the completion check runs only when enabled and its follow-up keeps the run going', async () => {
  let calls = 0
  const run = scripted(0, ['first answer', 'second answer'])
  const h = harness(run.chat)
  h.loop.setCompletionCheck(() => { calls += 1; return calls === 1 ? `${COMPLETION_CHECK_PREFIX}no-changes] make the change` : undefined })
  assert.equal(await h.agent.send('fix it', { budget: policy({ completionChecks: true }) }), 'second answer')
  assert.equal(calls, 2)
  assert.match(text(run.requests[1]!), /make the change/)
  const state = h.sessions.latestRun(h.session.id)!
  assert.equal(state.status, 'completed')
  const off = scripted(0, ['only answer'])
  const h2 = harness(off.chat)
  let offCalls = 0
  h2.loop.setCompletionCheck(() => { offCalls += 1; return 'never' })
  assert.equal(await h2.agent.send('fix it', { budget: policy() }), 'only answer')
  assert.equal(offCalls, 0)
  assert.throws(() => h2.loop.setCompletionCheck(() => undefined), /already fixed/)
})

test('completionCheck reports an empty diff, scratch files and an edit after the last command, each once', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-completion-'))
  try {
    const git = (...args: string[]) => spawnSync('git', args, { cwd: workspace, encoding: 'utf8' })
    git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't')
    await fs.writeFile(path.join(workspace, 'a.py'), 'x = 1\n'); git('add', '.'); git('commit', '-qm', 'base')
    const state = { runId: 'r1' } as Parameters<typeof completionCheck>[0]['state']
    const ev = (seq: number, type: string, data: unknown) => ({ version: 1, sessionId: 's', id: `e${seq}`, seq, runId: 'r1', taskId: 't', type, data, at: '' }) as SessionEvent
    // 宿主自己的结果存储不算改动。
    await fs.mkdir(path.join(workspace, '.mini-dsh', 'tool-results'), { recursive: true })
    await fs.writeFile(path.join(workspace, '.mini-dsh', 'tool-results', 'r.json'), '{}')
    let message = completionCheck({ workspace, events: [], state })
    assert.match(message!, /no-changes/)
    const asked = [ev(1, 'user/message', { content: message })]
    assert.equal(completionCheck({ workspace, events: asked, state }), undefined, 'each kind fires once')

    await fs.writeFile(path.join(workspace, 'a.py'), 'x = 2\n')
    await fs.writeFile(path.join(workspace, 'reproduce_bug.py'), 'print(1)\n')
    message = completionCheck({ workspace, events: [], state })
    assert.match(message!, /scratch-files\].*reproduce_bug\.py/)
    await fs.rm(path.join(workspace, 'reproduce_bug.py'))

    const edited = [ev(2, 'tool/start', { name: 'bash' }), ev(3, 'file/change', {})]
    message = completionCheck({ workspace, events: edited, state })
    assert.match(message!, /unverified-edit/)
    assert.equal(completionCheck({ workspace, events: [...edited, ev(4, 'tool/start', { name: 'bash' })], state }), undefined)
    assert.equal(completionCheck({ workspace, events: [...edited, ev(5, 'user/message', { content: message })], state }), undefined)
  } finally { await fs.rm(workspace, { recursive: true, force: true }) }
})

test('compact command text keeps exit status, both streams and the readback ref', () => {
  const base: CommandResult = { type: 'command', version: 1, command: 'pytest', cwd: '/w', status: 'exited', exitCode: 1, signal: null, durationMs: 1234,
    timedOut: false, cancelled: false, stdout: { text: 'head\n', bytes: 9000, truncated: false, previewTruncated: true, ref: 'r-1', omittedBytes: 8000, resumeOffset: 500, tail: 'tail\n' },
    stderr: { text: '', bytes: 0, truncated: false } }
  const rendered = renderCommandText(base)
  assert.equal(rendered, 'exit 1 (1.2s)\n--- stdout ---\nhead\n[stdout truncated: 8000 of 9000 bytes omitted; read_tool_result ref=r-1 offset=500]\ntail')
  const timedOut = renderCommandText({ ...base, status: 'timed_out', exitCode: null, timedOut: true, stdout: { text: '', bytes: 0, truncated: false } })
  assert.equal(timedOut, 'timed_out (1.2s)')
  assert.ok(renderCommandText({ ...base, stdout: { text: 'a"b\n', bytes: 4, truncated: false } }).includes('a"b'), 'no JSON escaping')
})
