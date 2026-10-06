import type { Context } from '@deepseek-ai/cordis'
import type { Readable, Writable } from 'node:stream'
import type { BudgetPolicy } from '../core/budget.js'
import type { RunOptions, ModelSelection } from '../core/contracts.js'
import readline from 'node:readline'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { BudgetStop, CLI_BUDGET, resolveBudget } from '../core/budget.js'
import { JsonlStore, isRecord } from '../core/event-store.js'
import { positiveLimit } from '../core/bounded-text.js'
import { utf8Prefix } from '../core/tool-result-store.js'
import type { taskChanges } from '../core/task-changes.js'
import type { taskReport } from '../core/task-verification.js'
import type { requestTrace } from '../core/task-trace.js'
export const name = 'mini-cli'
export const inject = ['sessions', 'agents', 'agentLoop', 'tools', 'systemPrompt', 'llm', 'sandbox']
export interface CliConfig {
  model?: string; input?: Readable & { isTTY?: boolean }; output?: Writable & { isTTY?: boolean }
  budget?: BudgetPolicy; sessionDirectory?: string | false; resumeSessionId?: string
  maxChangeOutputBytes?: number
}
function parsePolicy(text: string): BudgetPolicy {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) throw new Error('budget must be a JSON object')
  return value as BudgetPolicy
}
export async function apply(ctx: Context, config: CliConfig = {}) {
  const maxChangeOutputBytes = positiveLimit(config.maxChangeOutputBytes, 32 * 1024, 'maxChangeOutputBytes')
  if (maxChangeOutputBytes < 4) throw new Error('maxChangeOutputBytes must be at least 4 for UTF-8 pagination')
  const workspace = await fs.realpath(ctx.sandbox.workspace)
  const directory = config.sessionDirectory ?? process.env.MINI_DSH_SESSION_DIR ?? path.join(os.homedir(), '.mini-dsh', 'sessions')
  const resumeId = config.resumeSessionId ?? process.env.MINI_DSH_SESSION_ID
  const overrides = { ...(process.env.MINI_DSH_BUDGET ? parsePolicy(process.env.MINI_DSH_BUDGET) : {}), ...config.budget }
  let store: JsonlStore | undefined
  const session = resumeId && directory !== false
    ? await (async () => {
      store = await JsonlStore.open(directory, resumeId)
      try { return await ctx.sessions.restore(store, workspace) } catch (error) { await store.close(); throw error }
    })()
    : ctx.sessions.create({ source: 'cli', workspace })
  const saved = ctx.sessions.configuration(session.id)
  const model = config.model ?? saved?.model ?? ctx.sessions.latestRun(session.id)?.model ?? ctx.llm.defaultSelection()
  let budget: BudgetPolicy = { ...CLI_BUDGET, ...saved?.budget, ...overrides }
  const effective = (selection: ModelSelection = model, policy = budget) => resolveBudget(
    policy.contextWindowTokens === undefined && ctx.llm.capacity(selection) !== undefined ? { contextWindowTokens: ctx.llm.capacity(selection)! } : undefined, policy)
  try {
    effective()
    if (!resumeId && directory !== false) { store = await JsonlStore.open(directory, session.id); ctx.sessions.attachStore(session.id, store) }
    await ctx.sessions.flush(session.id)
  } catch (error) { await store?.close(); throw error }
  const agent = ctx.agents.create({ name: 'cli-agent', sessionId: session.id, model, budget, loop: ctx.agentLoop })
  const persistConfig = async () => { ctx.sessions.append(session.id, 'session/config', { model: String(agent.model), budget }); await ctx.sessions.flush(session.id) }
  ctx.effect(() => {
    const input = config.input ?? process.stdin, output = config.output ?? process.stdout
    const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) })
    const color = (code: number, text: string) => output.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text
    const print = (text: unknown) => { output.write(`${text}\n`) }
    let controller: AbortController | undefined, closed = false, exiting = false
    let approval: ((answer: string) => void) | undefined
    let queue = Promise.resolve()
    const prompt = () => { if (!closed) { rl.setPrompt('User > '); rl.prompt() } }
    const onKey = (chunk: Buffer | string) => { const bytes = Buffer.from(chunk); if (bytes.length === 1 && bytes[0] === 0x1b) controller?.abort() }
    input.on('data', onKey)
    print('mini-dsh — a local agent Harness')
    print('Commands: /tools /models /model /history /prompt /reset /continue /compact /budget [JSON] /changes [fileOffset] /diff [fileOffset] [byteOffset] /report [fileOffset] [verificationOffset] [byteOffset] /trace [requestOffset] [byteOffset] /exit')
    print(`Sandbox workspace: ${workspace}`)
    print(`Session: ${session.id}${store ? ` (${store.directory})` : ' (memory)'}`)
    print('Writes and bash execution ask [Y/n] first. Press Esc to cancel, including during approval.')
    print(`Model: ${agent.model}`)
    const disposeApprover = ctx.sandbox.setApprover(request => new Promise(resolve => {
      if (closed || request.signal?.aborted) { resolve(false); return }
      print(request.summary)
      const answer = (line: string) => {
        if (approval === answer) approval = undefined
        request.signal?.removeEventListener('abort', cancel)
        const allowed = /^(?:y|yes)?$/i.test(line.trim())
        if (!allowed) print('rejected.')
        resolve(allowed)
      }
      const cancel = () => answer('n')
      approval = answer; request.signal?.addEventListener('abort', cancel, { once: true })
      rl.setPrompt('Allow this? [Y/n] '); rl.prompt()
    }))
    function offset(text: string | undefined) {
      if (text === undefined) return 0
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('offset must be a nonnegative safe integer')
      return Number(text)
    }
    async function showChanges(includeDiff = false, fileOffset = 0, byteOffset = 0) {
      const tool = ctx.tools.get('task_changes')
      if (!tool) { if (includeDiff) print('[Changes unavailable] task_changes is not installed'); return }
      const properties = tool.parameters?.properties
      const filesParameter = isRecord(properties) ? properties.maxFiles : undefined
      const ceiling = isRecord(filesParameter) && typeof filesParameter.maximum === 'number' ? filesParameter.maximum : 20
      // CLI inspection is read-only; use the tool's configured limits without result projection.
      const report = await tool.execute({ includeDiff, offset: fileOffset, maxFiles: includeDiff ? 1 : Math.min(20, ceiling) }, { sessionId: session.id, signal: new AbortController().signal }) as Awaited<ReturnType<typeof taskChanges>>
      if (!report.taskId || !report.files.length) { print('[Changes] no tracked edits in this task'); return }
      if (!includeDiff) {
        const text = [`[Changes] task=${report.taskId} (file tools only)`, ...report.files.map(file => {
          const failed = file.attempts.filter(attempt => attempt.status === 'failed').length
          return `${file.status} ${file.path}${failed ? ` failedAttempts=${failed}` : ''}${file.externalChange ? ' [external change after editing]' : ''}${file.externalChangesBetweenEdits ? ' [external changes between edits; individual diffs]' : ''}${file.currentError ? ` [current file unavailable: ${file.currentError}]` : ''}`
        }), ...(!report.eof ? [`[more files: /changes ${report.nextOffset}]`] : [])].join('\n')
        const preview = utf8Prefix(Buffer.from(text), maxChangeOutputBytes).toString('utf8')
        print(preview + (preview.length < text.length ? '\n[change list truncated]' : ''))
        return
      }
      const file = report.files[0]
      print(`[Diff] ${file.path} status=${file.status} basis=${file.diffBasis}; confirmed edits only${file.externalChange ? '; current file has external changes' : ''}`)
      const bytes = Buffer.from(file.diff ?? '')
      if (byteOffset > bytes.length || (byteOffset < bytes.length && (bytes[byteOffset] & 0xc0) === 0x80)) throw new Error('byteOffset must be within the diff at a UTF-8 boundary')
      const preview = utf8Prefix(bytes.subarray(byteOffset), maxChangeOutputBytes)
      print(preview.toString('utf8') || '(no confirmed diff)')
      if (byteOffset + preview.length < bytes.length) print(`[diff truncated; continue: /diff ${fileOffset} ${byteOffset + preview.length}]`)
      else if (!report.eof) print(`[next file: /diff ${report.nextOffset}]`)
    }
    async function showReport(fileOffset = 0, verificationOffset = 0, byteOffset = 0, automatic = false) {
      const tool = ctx.tools.get('task_report')
      if (!tool) { if (!automatic) print('[Report unavailable] task_report is not installed'); return }
      const properties = tool.parameters?.properties
      const parameter = isRecord(properties) ? properties.maxFiles : undefined
      const maxFiles = isRecord(parameter) && typeof parameter.maximum === 'number' ? Math.min(20, parameter.maximum) : 20
      const report = await tool.execute({ fileOffset, verificationOffset, maxFiles, maxRecords: 20 }, { sessionId: session.id, signal: new AbortController().signal }) as Awaited<ReturnType<typeof taskReport>>
      const lines = [`[Report] session=${report.sessionId} task=${report.taskId ?? 'none'} run=${report.runStatus ?? 'none'} currentRun=${report.currentRunId ?? 'none'} stop=${report.stopReason ?? 'none'}; task acceptance not asserted`,
        `[Task usage] model=${report.taskCounters.modelRequests} tools=${report.taskCounters.toolCalls} input=${report.taskUsage.inputTokens} output=${report.taskUsage.outputTokens} total=${report.taskUsage.totalTokens} sources=${report.taskUsage.sources.join('+') || 'none'} uncertain=${report.taskUsage.uncertain}`,
        ...report.runs.map(run => `[Run] id=${run.runId} previous=${run.previousRunId ?? 'none'} model=${JSON.stringify(run.model)} status=${run.status} stop=${run.stopReason ?? 'none'} requests=${run.counters.modelRequests} tools=${run.counters.toolCalls} tokens=${run.counters.totalTokens}`),
        ...report.files.map(file => `[File] ${file.status} ${JSON.stringify(file.path)} verification=${file.verification}${file.externalChange ? ' externalChange=true' : ''}${file.currentError ? ` unavailable=${JSON.stringify(file.currentError)}` : ''}`),
        ...report.checks.map(check => `[Check] ${check.status} version=${check.freshness} id=${check.verificationId} command=${JSON.stringify(check.command)} cwd=${JSON.stringify(check.cwd)} exit=${check.commandResult?.exitCode ?? 'unknown'} files=${JSON.stringify(check.files)}`),
        ...(report.verificationTotal === 0 ? ['[Verification] no explicit checks recorded; code is unverified'] : []),
        ...(report.unverifiedFiles.length ? [`[Unverified files on this page] ${report.unverifiedFiles.map(file => JSON.stringify(file)).join(', ')}`] : []),
        '[Scope] file-tool edits and declared checks only; inspect every page before delivery',
        ...(!report.filesEof ? [`[more files: /report ${report.fileNextOffset} ${verificationOffset}]`] : []),
        ...(!report.verificationsEof ? [`[more checks: /report ${fileOffset} ${report.verificationNextOffset}]`] : [])]
      const bytes = Buffer.from(lines.join('\n'))
      if (byteOffset > bytes.length || (byteOffset < bytes.length && (bytes[byteOffset] & 0xc0) === 0x80)) throw new Error('byteOffset must be within the report at a UTF-8 boundary')
      const preview = utf8Prefix(bytes.subarray(byteOffset), maxChangeOutputBytes)
      print(preview.toString('utf8'))
      if (byteOffset + preview.length < bytes.length) print(`[report truncated; continue: /report ${fileOffset} ${verificationOffset} ${byteOffset + preview.length}]`)
    }
    async function showTrace(requestOffset = 0, byteOffset = 0) {
      const tool = ctx.tools.get('request_trace')
      if (!tool) { print('[Trace unavailable] request_trace is not installed'); return }
      const trace = await tool.execute({ requestOffset, maxRequests: 20 }, { sessionId: session.id, signal: new AbortController().signal }) as ReturnType<typeof requestTrace>
      const lines = [`[Trace] session=${trace.sessionId} task=${trace.taskId ?? 'none'} requests=${trace.total} offset=${trace.offset}`]
      for (const request of trace.requests) {
        lines.push(`[Request] id=${request.requestId} run=${request.runId} model=${JSON.stringify(request.model)} runStatus=${request.runStatus} stop=${request.stopReason ?? 'none'} estimatedInput=${request.estimatedInputTokens ?? 'unknown'} usage=${request.usage ? `${request.usage.totalTokens}/${request.usage.source}${request.usage.uncertain ? '/uncertain' : ''}` : 'missing'} complete=${request.completion?.complete ?? 'missing'} finish=${request.completion?.finishReason ?? 'none'} response=${request.response.kind}`)
        if (request.projection) lines.push(`[Projection] input=${request.projection.estimatedInputTokens} outputReserve=${request.projection.reservedOutputTokens} margin=${request.projection.safetyMarginTokens} removedTasks=${request.projection.removedTaskIds.length}`)
        if (request.response.kind === 'tool_calls') for (const call of request.response.toolCalls) lines.push(`[Tool trace] id=${call.toolCallId} name=${call.name} started=${call.started} outcome=${call.outcome} changes=${JSON.stringify(call.changeIds)} verifications=${JSON.stringify(call.verificationIds)}`)
      }
      lines.push('[Trace scope] confirmed current-task summaries only; prompts, reasoning, arguments, result bodies and logs omitted')
      if (!trace.eof) lines.push(`[more requests: /trace ${trace.nextOffset}]`)
      const bytes = Buffer.from(lines.join('\n'))
      if (byteOffset > bytes.length || (byteOffset < bytes.length && (bytes[byteOffset] & 0xc0) === 0x80)) throw new Error('byteOffset must be within the trace at a UTF-8 boundary')
      const preview = utf8Prefix(bytes.subarray(byteOffset), maxChangeOutputBytes)
      print(preview.toString('utf8'))
      if (byteOffset + preview.length < bytes.length) print(`[trace truncated; continue: /trace ${requestOffset} ${byteOffset + preview.length}]`)
    }
    async function runInput(text?: string) {
      controller = new AbortController()
      let segment = '', streamed = false
      const endSegment = () => { if (segment) output.write('\n'); segment = '' }
      const options: RunOptions = {
        signal: controller.signal,
        onReasoning(chunk) { if (segment !== 'thinking') { endSegment(); output.write(color(90, '[Thinking] ')); segment = 'thinking' }; output.write(color(90, chunk)) },
        onContent(chunk) { streamed = true; if (segment !== 'content') { endSegment(); output.write('Agent > '); segment = 'content' }; output.write(chunk) },
        onToolCall(call) { endSegment(); print(color(36, `[Tool] ${call.name} ${JSON.stringify(call.arguments)}`)) },
        onToolResult(result) { endSegment(); print(color(32, `[Result] ${result.renderedContent.slice(0, 300)}`)) },
      }
      try {
        const answer = text === undefined ? await agent.continue(options) : await agent.send(text, options)
        endSegment(); if (!streamed) print(`Agent > ${answer}`)
      } catch (error) {
        endSegment()
        if (error instanceof BudgetStop) print(`[stopped: ${error.reason}] Use /budget to inspect or /continue to start another run.`)
        else print(`[AgentError] ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        controller = undefined
        const state = ctx.sessions.latestRun(session.id)
        if (state) {
          const c = state.counters, task = ctx.sessions.taskState(session.id, state.taskId)
          print(`[Run ${state.status}] model=${c.modelRequests}, tools=${c.toolCalls}, tokens=${c.totalTokens} (${[...new Set(state.usage.map(u => u.source))].join('+') || 'none'}), active=${Math.round(c.activeDurationMs)}ms, removedTasks=${state.removedTaskIds.length}`)
          if (state.terminalCommit?.status === 'uncertain') print('[Persistence uncertain] Close and restore this session to verify its terminal record before continuing.')
          print(`[Task] runs=${task.runIds.length}, tokens=${task.counters.totalTokens}, model=${task.counters.modelRequests}, tools=${task.counters.toolCalls}`)
          try { await showChanges() } catch (error) { print(`[Changes unavailable] ${error instanceof Error ? error.message : String(error)}`) }
          try { await showReport(0, 0, 0, true) } catch (error) { print(`[Report unavailable] ${error instanceof Error ? error.message : String(error)}`) }
        }
      }
    }
    async function handle(line: string) {
      const text = line.trim()
      if (!text || exiting) return
      if (!text.startsWith('/')) { await runInput(text); return }
      const [command, ...parts] = text.split(/\s+/)
      switch (command) {
        case '/tools': print(ctx.tools.list().map(tool => `${tool.name}: ${tool.description ?? ''}`).join('\n') || '(no tools)'); break
        case '/models': print(ctx.llm.models().join('\n')); break
        case '/model': {
          const selection = parts.join(' ')
          if (!selection) print(String(agent.model))
          else if (!ctx.llm.has(selection)) print(`Unknown model: ${selection}`)
          else { effective(selection); agent.model = selection; await persistConfig(); print(`Model: ${selection}`) }
          break
        }
        case '/budget': {
          if (parts.length) { const next = { ...budget, ...parsePolicy(parts.join(' ')) }; effective(agent.model, next); budget = next; agent.budget = next; await persistConfig() }
          const run = ctx.sessions.latestRun(session.id)
          print(JSON.stringify({ policy: effective(agent.model), run, task: run ? ctx.sessions.taskState(session.id, run.taskId) : undefined, estimate: 'ASCII 0.3 / other Unicode 1.0; message 32 / request 256; estimated usage is uncertain' }, null, 2))
          break
        }
        case '/continue': await runInput(); break
        // 压缩是人或框架的事，不是模型的事——所以它是个人工命令，不是模型可调用的工具。
        // 它永远可用：不受失败闩影响，也不被 auto 关掉（AGENTS.md 的「最后手段」由人保留）。
        case '/compact': {
          if (parts.length) throw new Error('usage: /compact')
          const before = ctx.sessions.visibleEvents(session.id).length
          try {
            const applied = await ctx.agentLoop.compact(agent, { signal: new AbortController().signal })
            // **只看这次尝试新写的事件**：在全会话里反查最近一条会把上一次压缩的原因与统计回显成本次结果，
            // 而 skipped（没有可压缩的段）连括号都不写，正是最容易被冒充成「刚刚 declined」的情形。
            // 判据是 summary-start 而**不是**「有没有新事件」——维护型 run 自己就会写 run/start 与 run/finish。
            const added = ctx.sessions.visibleEvents(session.id).slice(before)
            const attempted = added.some(event => event.type === 'context/summary-start')
            const end = added.find(event => event.type === 'context/summary-end')
            const reason = end?.type === 'context/summary-end' && end.data.outcome.kind === 'declined' ? end.data.outcome.reason : undefined
            if (applied) print('[Compact] applied: the earlier part of this task now sits behind a summary frame; the original events are still in /history and readable with read_history.')
            else if (!attempted) print('inputTargetTokens' in effective(agent.model) || 'compactionBudgetTokens' in effective(agent.model)
              ? '[Compact] nothing to compact: this task has no compactable range; the projection is unchanged.'
              : '[Compact] nothing to compact: no compaction budget is configured (set inputTargetTokens or compactionBudgetTokens); the projection is unchanged.')
            else print(`[Compact] not applied${reason ? ` (${reason})` : ''}; the projection is unchanged.`)
            const summary = added.find(event => event.type === 'context/summary')
            if (summary?.type === 'context/summary') print(`[Compact] replaced ${summary.data.shadowedSeqs.length} events (${summary.data.shadowedTokens} estimated tokens) with ${summary.data.summaryTokens}; retained=${summary.data.retainedNodes}`)
          } catch (error) {
            if (error instanceof BudgetStop) print(`[Compact] stopped: ${error.reason}`)
            else print(`[CompactError] ${error instanceof Error ? error.message : String(error)}`)
          }
          print(`[Compact] events added: ${ctx.sessions.visibleEvents(session.id).length - before}`)
          break
        }
        case '/changes': if (parts.length > 1) throw new Error('usage: /changes [fileOffset]'); await showChanges(false, offset(parts[0])); break
        case '/diff': if (parts.length > 2) throw new Error('usage: /diff [fileOffset] [byteOffset]'); await showChanges(true, offset(parts[0]), offset(parts[1])); break
        case '/report': if (parts.length > 3) throw new Error('usage: /report [fileOffset] [verificationOffset] [byteOffset]'); await showReport(offset(parts[0]), offset(parts[1]), offset(parts[2])); break
        case '/trace': if (parts.length > 2) throw new Error('usage: /trace [requestOffset] [byteOffset]'); await showTrace(offset(parts[0]), offset(parts[1])); break
        case '/history': print(JSON.stringify(ctx.sessions.get(session.id).events, null, 2)); break
        case '/prompt': print(await ctx.systemPrompt.assemble({ agent, sessionId: session.id })); break
        case '/reset': ctx.sessions.clear(session.id); await persistConfig(); print(`Session reset: ${session.id}`); break
        case '/exit': exiting = true; rl.close(); return
        default: print(`Unknown command: ${command}`)
      }
    }
    rl.on('line', line => {
      line = line.replace(/\x1b(?:\[[0-9;]*[A-Za-z])?/g, '')
      if (approval) { approval(line); return }
      queue = queue.then(() => handle(line)).catch(error => print(`[CLIError] ${error instanceof Error ? error.message : String(error)}`)).finally(prompt)
    })
    rl.on('close', () => { closed = true; approval?.('n'); void queue.then(() => ctx.root.fiber.dispose()).catch(error => print(`[DisposeError] ${String(error)}`)) })
    prompt()
    return async () => {
      closed = true; disposeApprover(); approval?.('n'); controller?.abort(); input.off('data', onKey); rl.close()
      await queue; await ctx.sessions.flush(session.id); await store?.close()
    }
  }, 'run cli')
}
