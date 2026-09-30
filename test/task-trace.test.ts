import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { JsonlStore } from '../src/core/event-store.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import { requestTrace } from '../src/core/task-trace.js'
import * as tools from '../src/plugins/tools.js'
import * as sandbox from '../src/plugins/sandbox.js'
import * as systemPrompt from '../src/plugins/system-prompt.js'
import * as sessionPlugin from '../src/plugins/session.js'
import * as files from '../src/tools/files.js'

const usage = (source: 'provider' | 'estimated' = 'provider') => ({ inputTokens: 10, outputTokens: 2, totalTokens: 12, source, uncertain: source === 'estimated' })

test('request trace links requests, repeated tool ids and evidence within each request without copying bodies', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-trace-'))
  const sessions = new SessionRuntime(), session = sessions.create({ workspace: directory })
  const store = await JsonlStore.open(directory, session.id)
  try {
    sessions.attachStore(session.id, store)
    const first = sessions.beginRun(session.id, {}, 'mock/one')
    const append = <K extends Parameters<SessionRuntime['append']>[1]>(type: K, data: Parameters<SessionRuntime['append']>[2]) => sessions.append(session.id, type, data as never, first)
    append('context/projection', { estimatedInputTokens: 100, reservedOutputTokens: 20, safetyMarginTokens: 10, removedTaskIds: [] })
    append('model/start', { taskId: first.taskId, runId: first.runId, requestId: 'r1', estimatedInputTokens: 100 })
    append('model/usage', { taskId: first.taskId, runId: first.runId, requestId: 'r1', usage: usage() })
    append('model/end', { requestId: 'r1', complete: true, finishReason: 'tool_calls' })
    append('assistant/tool_calls', { reasoningContent: 'SECRET_REASONING', toolCalls: [{ id: 'duplicate', name: 'edit_file', arguments: { secret: 'SECRET_ARGUMENT' } }] })
    append('tool/start', { taskId: first.taskId, runId: first.runId, toolCallId: 'duplicate', name: 'edit_file' })
    append('file/change', { changeId: 'change-r1', path: 'a.ts', tool: 'edit_file', toolCallId: 'duplicate' })
    append('file/change-result', { changeId: 'change-r1', status: 'failed', error: 'mock conflict' })
    append('tool/result', { toolCallId: 'duplicate', name: 'edit_file', isError: true, status: 'completed', content: 'SECRET_RESULT' })
    append('context/projection', { estimatedInputTokens: 120, reservedOutputTokens: 20, safetyMarginTokens: 12, removedTaskIds: [] })
    append('model/start', { taskId: first.taskId, runId: first.runId, requestId: 'r2', estimatedInputTokens: 120 })
    append('model/end', { requestId: 'r2', complete: true, finishReason: 'tool_calls' })
    append('assistant/tool_calls', { toolCalls: [{ id: 'duplicate', name: 'bash', arguments: { command: 'SECRET_COMMAND' } }] })
    append('verification/start', { verificationId: 'verification-r2', command: 'node check.mjs', cwd: '.', toolCallId: 'duplicate', files: [{ path: 'a.ts', hash: 'missing' }] })
    append('tool/result', { toolCallId: 'duplicate', name: 'bash', isError: true, status: 'skipped', content: 'SECRET_SKIP' })
    sessions.finishRun(first, 'max_steps')
    await sessions.flush(session.id)

    const second = sessions.beginRun(session.id, {}, 'mock/two', true)
    const appendSecond = <K extends Parameters<SessionRuntime['append']>[1]>(type: K, data: Parameters<SessionRuntime['append']>[2]) => sessions.append(session.id, type, data as never, second)
    appendSecond('context/projection', { estimatedInputTokens: 140, reservedOutputTokens: 20, safetyMarginTokens: 14, removedTaskIds: [] })
    appendSecond('model/start', { taskId: second.taskId, runId: second.runId, requestId: 'r3', estimatedInputTokens: 140 })
    appendSecond('assistant/tool_calls', { toolCalls: [{ id: 'duplicate', name: 'write_file', arguments: { content: 'SECRET_CONTENT' } }] })
    appendSecond('tool/start', { taskId: second.taskId, runId: second.runId, toolCallId: 'duplicate', name: 'write_file' })
    appendSecond('tool/result', { toolCallId: 'duplicate', name: 'write_file', isError: true, status: 'unknown', content: 'SECRET_UNKNOWN' })
    appendSecond('context/projection', { estimatedInputTokens: 160, reservedOutputTokens: 20, safetyMarginTokens: 16, removedTaskIds: [] })
    appendSecond('model/start', { taskId: second.taskId, runId: second.runId, requestId: 'r4', estimatedInputTokens: 160 })
    appendSecond('model/usage', { taskId: second.taskId, runId: second.runId, requestId: 'r4', usage: usage('estimated') })
    appendSecond('model/end', { requestId: 'r4', complete: true })
    appendSecond('assistant/message', { content: 'SECRET_ANSWER' })
    sessions.finishRun(second, 'completed')
    await sessions.flush(session.id)

    const firstPage = requestTrace(sessions, session.id, 0, 2)
    assert.equal(firstPage.total, 4); assert.equal(firstPage.eof, false); assert.equal(firstPage.nextOffset, 2)
    assert.deepEqual(firstPage.requests.map(request => request.requestId), ['r1', 'r2'])
    assert.equal(firstPage.requests[0].response.kind, 'tool_calls')
    if (firstPage.requests[0].response.kind === 'tool_calls') {
      assert.deepEqual(firstPage.requests[0].response.toolCalls[0], { toolCallId: 'duplicate', name: 'edit_file', started: true, resultStatus: 'completed', outcome: 'failed', isError: true, changeIds: ['change-r1'], verificationIds: [] })
    }
    if (firstPage.requests[1].response.kind === 'tool_calls') {
      assert.deepEqual(firstPage.requests[1].response.toolCalls[0].verificationIds, ['verification-r2'])
      assert.equal(firstPage.requests[1].response.toolCalls[0].outcome, 'skipped')
      assert.deepEqual(firstPage.requests[1].response.toolCalls[0].changeIds, [])
    }
    const secondPage = requestTrace(sessions, session.id, 2, 2)
    assert.equal(secondPage.eof, true); assert.equal(secondPage.requests[0].completion, null); assert.equal(secondPage.requests[0].usage, null)
    if (secondPage.requests[0].response.kind === 'tool_calls') assert.equal(secondPage.requests[0].response.toolCalls[0].outcome, 'unknown')
    assert.deepEqual(secondPage.requests[1].response, { kind: 'message' }); assert.equal(secondPage.requests[1].usage?.source, 'estimated')
    assert.equal(secondPage.requests[1].runStatus, 'completed'); assert.equal(secondPage.requests[1].stopReason, 'completed')
    assert.doesNotMatch(JSON.stringify({ firstPage, secondPage }), /SECRET_/)

    await store.close()
    const reopened = await JsonlStore.open(directory, session.id), restored = new SessionRuntime()
    await restored.restore(reopened, directory)
    assert.deepEqual(requestTrace(restored, session.id, 0, 10), requestTrace(sessions, session.id, 0, 10))
    restored.clear(session.id); await restored.flush(session.id)
    const next = restored.beginRun(session.id, {}, 'mock/reset')
    restored.append(session.id, 'model/start', { taskId: next.taskId, runId: next.runId, requestId: 'after-reset' }, next)
    await restored.flush(session.id)
    assert.deepEqual(requestTrace(restored, session.id).requests.map(request => request.requestId), ['after-reset'])
    await reopened.close()
  } finally {
    await store.close()
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('request_trace tool enforces session and pagination limits and is released with the files plugin', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'request-trace-tool-')), root = new Context()
  try {
    for (const plugin of [sessionPlugin, tools, systemPrompt]) await root.plugin(plugin)
    await root.plugin(sandbox, { workspace, autoApprove: true }); await root.plugin(files)
    const session = root.sessions.create({ workspace }), run = root.sessions.beginRun(session.id, {}, 'mock/tool')
    root.sessions.append(session.id, 'context/projection', { estimatedInputTokens: 10, reservedOutputTokens: 5, safetyMarginTokens: 2, removedTaskIds: [] }, run)
    root.sessions.append(session.id, 'model/start', { taskId: run.taskId, runId: run.runId, requestId: 'tool-visible' }, run)
    root.sessions.append(session.id, 'model/end', { requestId: 'tool-visible', complete: true }, run)
    root.sessions.append(session.id, 'assistant/message', { content: 'private answer' }, run)
    assert.equal((await root.tools.execute('request_trace')).isError, true)
    for (const args of [{ requestOffset: -1 }, { requestOffset: 0.5 }, { maxRequests: 0 }, { maxRequests: 101 }]) {
      assert.equal((await root.tools.execute('request_trace', args, { sessionId: session.id })).isError, true)
    }
    const result = await root.tools.execute('request_trace', { requestOffset: 0, maxRequests: 1 }, { sessionId: session.id })
    assert.equal(result.isError, false)
    const trace = result.value as ReturnType<typeof requestTrace>
    assert.equal(trace.sessionId, session.id); assert.equal(trace.taskId, run.taskId)
    assert.deepEqual(trace.requests.map(request => request.requestId), ['tool-visible'])
    assert.doesNotMatch(JSON.stringify(trace), /private answer/)
    const service = root.tools; await root.fiber.dispose(); assert.equal(service.get('request_trace'), undefined)
  } finally { await root.fiber.dispose(); await fs.rm(workspace, { recursive: true, force: true }) }
})
