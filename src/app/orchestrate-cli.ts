import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import type { Writable } from 'node:stream'
import type { ApprovalRequest } from '../core/contracts.js'
import type { PlanInput, RootBudget } from '../orchestration/contracts.js'
import { assertPlanInput } from '../orchestration/validation.js'
import { orchestrate } from '../orchestration/orchestrator.js'
import { formatOrchestration, loadOrchestration } from '../orchestration/inspect.js'
import { assertRootId, orchestrationDirectory } from '../orchestration/store.js'
import { WorktreeManager } from '../orchestration/worktrees.js'
import { repositoryRoot } from '../orchestration/git.js'

const USAGE = `usage:
  mini-dsh orchestrate run (--task <text> | --task-file <path>) --plan <plan.json>
    [--mode auto|single|parallel] [--max-workers 1..4] [--root-budget <json>]
    [--verify <cmd>]... [--prepare <cmd>] [--approve-writes auto|ask] [--approve-bash ask|auto] [--allow-dirty]
  mini-dsh orchestrate inspect <rootId|log-path> [--json]
  mini-dsh orchestrate list
  mini-dsh orchestrate cleanup <rootId>`
export interface OrchestrateRunArgs {
  kind: 'run'
  task?: string
  taskFile?: string
  planPath: string
  mode: 'auto' | 'single' | 'parallel'
  maxWorkers: number
  rootBudget: Partial<RootBudget>
  verifyCommands: string[]
  prepareCommand?: string
  approveWrites: 'auto' | 'ask'
  approveBash: 'ask' | 'auto'
  allowDirty: boolean
}
export type OrchestrateCommand =
  | OrchestrateRunArgs
  | { kind: 'inspect'; target: string; json: boolean }
  | { kind: 'list' }
  | { kind: 'cleanup'; rootId: string }
function value(args: string[], index: number, flag: string) {
  const next = args[index + 1]
  if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value`)
  return next
}
function parseObject(text: string, name: string) {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error(`${name} must be a JSON object`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be a JSON object`)
  return value as Partial<RootBudget>
}
export function parseOrchestrateArgs(args: string[]): OrchestrateCommand {
  const [command, ...rest] = args
  if (command === 'run') {
    const result: OrchestrateRunArgs = { kind: 'run', planPath: '', mode: 'auto', maxWorkers: 2, rootBudget: {}, verifyCommands: [], approveWrites: 'auto', approveBash: 'ask', allowDirty: false }
    for (let index = 0; index < rest.length; index++) {
      const flag = rest[index]!
      if (flag === '--task') { if (result.task !== undefined) throw new Error('--task may only be given once'); result.task = value(rest, index, flag); index++ }
      else if (flag === '--task-file') { if (result.taskFile !== undefined) throw new Error('--task-file may only be given once'); result.taskFile = value(rest, index, flag); index++ }
      else if (flag === '--plan') { if (result.planPath) throw new Error('--plan may only be given once'); result.planPath = value(rest, index, flag); index++ }
      else if (flag === '--mode') { const mode = value(rest, index, flag); if (!['auto', 'single', 'parallel'].includes(mode)) throw new Error('--mode must be auto, single or parallel'); result.mode = mode as OrchestrateRunArgs['mode']; index++ }
      else if (flag === '--max-workers') { const text = value(rest, index, flag); if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 4) throw new Error('--max-workers must be 1..4'); result.maxWorkers = Number(text); index++ }
      else if (flag === '--root-budget') { result.rootBudget = parseObject(value(rest, index, flag), '--root-budget'); index++ }
      else if (flag === '--verify') { result.verifyCommands.push(value(rest, index, flag)); index++ }
      else if (flag === '--prepare') { result.prepareCommand = value(rest, index, flag); index++ }
      else if (flag === '--approve-writes') { const mode = value(rest, index, flag); if (mode !== 'auto' && mode !== 'ask') throw new Error('--approve-writes must be auto or ask'); result.approveWrites = mode; index++ }
      else if (flag === '--approve-bash') { const mode = value(rest, index, flag); if (mode !== 'ask' && mode !== 'auto') throw new Error('--approve-bash must be ask or auto'); result.approveBash = mode; index++ }
      else if (flag === '--allow-dirty') result.allowDirty = true
      else throw new Error(`unknown orchestrate run option: ${flag}\n${USAGE}`)
    }
    if (Boolean(result.task) === Boolean(result.taskFile)) throw new Error('exactly one of --task and --task-file is required')
    if (!result.planPath) throw new Error('--plan is required (the planner lands in M2)')
    return result
  }
  if (command === 'inspect') {
    if (rest.length < 1 || rest.length > 2 || (rest[1] !== undefined && rest[1] !== '--json')) throw new Error(USAGE)
    return { kind: 'inspect', target: rest[0]!, json: rest[1] === '--json' }
  }
  if (command === 'list') {
    if (rest.length) throw new Error(USAGE)
    return { kind: 'list' }
  }
  if (command === 'cleanup') {
    if (rest.length !== 1) throw new Error(USAGE)
    return { kind: 'cleanup', rootId: rest[0]! }
  }
  throw new Error(USAGE)
}
export function orchestrationBaseDirectory(env: NodeJS.ProcessEnv = process.env) {
  return env.MINI_DSH_ORCHESTRATION_DIR ?? path.join(os.homedir(), '.mini-dsh', 'orchestrations')
}
function terminalApprover(output: Writable) {
  const input = process.stdin
  const rl = readline.createInterface({ input, output, terminal: Boolean((input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY) })
  let closed = false
  rl.on('close', () => { closed = true })
  return {
    ask: (request: ApprovalRequest) => new Promise<boolean>(resolve => {
      if (closed || request.signal?.aborted) return resolve(false)
      output.write(`\n[approval] ${request.summary}\nAllow this? [Y/n] `)
      const done = (allowed: boolean) => {
        rl.removeListener('line', onLine)
        request.signal?.removeEventListener('abort', onAbort)
        resolve(allowed)
      }
      const onLine = (line: string) => done(/^(?:y|yes)?$/i.test(line.trim()))
      const onAbort = () => done(false)
      rl.once('line', onLine)
      request.signal?.addEventListener('abort', onAbort, { once: true })
    }),
    close: () => rl.close(),
  }
}
async function readPlan(file: string): Promise<PlanInput> {
  const text = await fs.readFile(file, 'utf8')
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('plan file exceeds 64 KiB')
  let value: unknown
  try { value = JSON.parse(text) } catch (error) { throw new Error('plan file is not valid JSON', { cause: error }) }
  assertPlanInput(value)
  return value
}
async function readGoal(args: OrchestrateRunArgs) {
  const goal = args.taskFile ? await fs.readFile(args.taskFile, 'utf8') : args.task!
  if (!goal.trim()) throw new Error('task must be nonempty')
  if (Buffer.byteLength(goal) > 4096) throw new Error('task exceeds 4096 bytes')
  return goal
}
async function executeRun(args: OrchestrateRunArgs, output: Writable) {
  const { default: dotenv } = await import('dotenv')
  dotenv.config({ quiet: true })
  const goal = await readGoal(args), plan = await readPlan(args.planPath)
  const budget: Partial<RootBudget> = {
    ...(process.env.MINI_DSH_ROOT_BUDGET ? parseObject(process.env.MINI_DSH_ROOT_BUDGET, 'MINI_DSH_ROOT_BUDGET') : {}),
    ...args.rootBudget,
  }
  const { createDeepSeekAdapter } = await import('../models/deepseek.js')
  const model = process.env.MINI_DSH_MODEL ?? 'deepseek-v4-pro'
  const base = createDeepSeekAdapter({ defaultModel: model })
  const approver = args.approveWrites === 'ask' || args.approveBash === 'ask' ? terminalApprover(output) : undefined
  try {
    const result = await orchestrate({
      repository: process.env.MINI_DSH_WORKSPACE ?? process.cwd(), goal, plan, baseDirectory: orchestrationBaseDirectory(),
      adapter: { provider: 'deepseek', model, chat: base.chat, ...(base.capabilities ? { capabilities: base.capabilities } : {}) },
      model: `deepseek/${model}`, mode: args.mode, maxWorkers: args.maxWorkers, rootBudget: budget,
      ...(args.prepareCommand ? { prepareCommand: args.prepareCommand } : {}),
      verifyCommands: args.verifyCommands, allowDirty: args.allowDirty,
      approval: { writes: args.approveWrites, bash: args.approveBash, ...(approver ? { approve: approver.ask } : {}) },
      onProgress: line => output.write(`${line}\n`),
    })
    output.write(`\norchestration ${result.status}\nroot: ${result.rootId}\nbase: ${result.baseCommit}\nlog: ${result.directory}\n`)
    if (result.integrationBranch) output.write(`integration branch: ${result.integrationBranch} (not merged into your working tree)\n`)
    if (result.reportRef) output.write(`report: ${path.join(result.directory, 'artifacts', `sha256-${result.reportRef.slice('sha256:'.length)}.json`)}\n`)
    if (result.status === 'needs_human') {
      const report = await loadOrchestration(result.directory)
      output.write(`${formatOrchestration({ ...report, events: report.events.length })}\n`)
      output.write('Resolve the human request before continuing; conflict decisions and resume land in M2/M3.\n')
    }
    if (result.error) output.write(`error: ${result.error}\n`)
    return result.status === 'completed' ? 0 : 1
  } finally {
    approver?.close()
  }
}
export async function runOrchestrateCli(args: string[], output: Writable = process.stdout): Promise<number> {
  try {
    const command = parseOrchestrateArgs(args)
    if (command.kind === 'run') return await executeRun(command, output)
    if (command.kind === 'inspect') {
      const target = command.target.endsWith('.jsonl') ? command.target : (() => { assertRootId(command.target); return path.join(orchestrationBaseDirectory(), command.target) })()
      const report = await loadOrchestration(target)
      if (command.json) output.write(JSON.stringify({ rootId: report.rootId, logPath: report.logPath, totals: report.totals, state: report.state, events: report.events.length }, null, 2) + '\n')
      else output.write(formatOrchestration({ ...report, events: report.events.length }) + '\n')
      return 0
    }
    if (command.kind === 'list') {
      const base = orchestrationBaseDirectory()
      const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => [])
      const roots = entries.filter(entry => entry.isDirectory() && /^rt_/.test(entry.name)).map(entry => path.join(base, entry.name))
      output.write(roots.length ? roots.join('\n') + '\n' : 'no orchestrations\n')
      return 0
    }
    assertRootId(command.rootId)
    const repository = await repositoryRoot(process.env.MINI_DSH_WORKSPACE ?? process.cwd())
    const manager = new WorktreeManager(repository, command.rootId, orchestrationDirectory(orchestrationBaseDirectory(), command.rootId))
    await manager.cleanup()
    output.write(`cleaned ${command.rootId}\n`)
    return 0
  } catch (error) {
    output.write(`[orchestrate] ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
