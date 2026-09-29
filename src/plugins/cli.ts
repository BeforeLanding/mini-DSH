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
export const name = 'mini-cli'
export const inject = ['sessions', 'agents', 'agentLoop', 'tools', 'systemPrompt', 'llm', 'sandbox']
export interface CliConfig {
  model?: string; input?: Readable & { isTTY?: boolean }; output?: Writable & { isTTY?: boolean }
  budget?: BudgetPolicy; sessionDirectory?: string | false; resumeSessionId?: string
}
function parsePolicy(text: string): BudgetPolicy {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) throw new Error('budget must be a JSON object')
  return value as BudgetPolicy
}
export async function apply(ctx: Context, config: CliConfig = {}) {
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
    const escape = (chunk: Buffer | string) => { const bytes = Buffer.from(chunk); if (bytes.length === 1 && bytes[0] === 0x1b) controller?.abort() }
    input.on('data', escape)
    print('mini-dsh — a local agent Harness')
    print('Commands: /tools /models /model /history /prompt /reset /continue /budget [JSON] /exit')
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
          print(`[Task] runs=${task.runIds.length}, tokens=${task.counters.totalTokens}, model=${task.counters.modelRequests}, tools=${task.counters.toolCalls}`)
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
      closed = true; disposeApprover(); approval?.('n'); controller?.abort(); input.off('data', escape); rl.close()
      await queue; await ctx.sessions.flush(session.id); await store?.close()
    }
  }, 'run cli')
}
