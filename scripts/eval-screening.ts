import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { fixtureIds } from './coding-fixtures.js'
import type { FixtureId } from './coding-fixtures.js'
import { evalPolicy, phaseCaps, runPhase, summarize } from './eval-runner.js'
import type { RunOutcome } from './eval-runner.js'
import { runFixtureTask } from './eval-fixture.js'
import { createDeepSeekAdapter } from '../src/models/deepseek.js'
import type { ChatResponse } from '../src/core/contracts.js'

// NX-08d 筛查跑的真实适配器入口。与 eval-offline 共用同一套运行器与 fixture 驱动，区别只在适配器来源、
// 预算口径（evalPolicy 而非裸 singleRunBudget）和证据落盘。本脚本会真实计费，默认不做任何事以外的
// 干预：不重试、不跳过、不因单次失败中止阶段，只把每步的累计用量打出来供人工决定是否继续。
dotenv.config({ quiet: true })

const repository = fileURLToPath(new URL('../../', import.meta.url))
const options = parseArguments(process.argv.slice(2))
const phase = 'screening'

const planned = resolvePlanned(options.get('tasks'))
const infeasible = resolveInfeasible(options.get('infeasible'), options.get('infeasible-reason'))
const model = resolveModel()

// 证据目录按「阶段 + 覆盖范围」分开放，并一次一跑：烟测的单个任务不会挡住整批，也不会混进整批的
// 记录；同一范围重复运行时直接拒绝写入，避免“整体重跑”被误读成“同一次运行的追加”。
const coversEverything = planned.length === fixtureIds.length && planned.every((id, index) => id === fixtureIds[index])
const scope = coversEverything ? 'full' : planned.join('-')
const evidenceDirectory = process.env.MINI_DSH_EVAL_EVIDENCE_DIR ?? path.join(repository, '.eval-evidence', `${phase}-${scope}`)
const sessionDirectory = path.join(evidenceDirectory, 'sessions')
const runLog = path.join(evidenceDirectory, 'runs.jsonl')
const reportPath = path.join(evidenceDirectory, 'report.json')

const selection = model.includes('/') ? model.split('/') : ['deepseek', model]
const [provider, modelId] = [selection[0], selection.slice(1).join('/')]
if (provider !== 'deepseek') throw new Error(`only the deepseek provider is wired for paid runs, got: ${provider}`)
if (!modelId) throw new Error('MINI_DSH_MODEL must name a model, e.g. deepseek/deepseek-v4-flash')

const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
// 窗口能力必须明确：官方端点取 PLAN 保守配置的 1,000,000，自定义端点不允许靠模型名猜。
const declaredWindow = process.env.MINI_DSH_EVAL_CONTEXT_WINDOW
const contextWindowTokens = declaredWindow ? Number(declaredWindow) : baseUrl === 'https://api.deepseek.com' ? 1_000_000 : undefined
if (contextWindowTokens === undefined) throw new Error('MINI_DSH_EVAL_CONTEXT_WINDOW is required for a non-official endpoint')
if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) throw new Error('MINI_DSH_EVAL_CONTEXT_WINDOW must be a positive safe integer')

const adapter = createDeepSeekAdapter({ baseUrl, models: [modelId], contextWindowTokens })
console.log(`${phase}-${scope}: ${provider}/${modelId} @ ${baseUrl}, window ${contextWindowTokens}, ${planned.length} 个任务`)
console.log(`预算：单次 run ${evalPolicy.maxModelRequests} 请求 / ${evalPolicy.maxToolCalls} 工具 / ${evalPolicy.maxActiveDurationMs}ms / ${evalPolicy.maxTotalTokens} token；整批 ${phaseCaps[phase].requests} 请求 / ${phaseCaps[phase].tokens} token`)

// 先确认这次能落盘再发任何付费请求：证据目录冲突时就该在花钱之前停下。
if (!options.has('probe-only')) await ensureWritable()

// 花整批的钱之前先用两次极小请求把协议风险排掉：模型名是否被接受、服务端回显的是哪个 model、
// usage 的字段形状、thinking 与流式解析能不能走通。任一不符就在这里停下，不进入 12 个任务的批次。
const probe = await probeProtocol()
console.log(`探测：回显 model=${probe.echoedModel ?? '(缺失)'}、finish_reason=${probe.finishReason ?? '(缺失)'}、usage=${JSON.stringify(probe.usage)}`)
// 流式探测看的是协议能否走通，不是模型能否作答：thinking 打开时输出额度可能全被推理吃掉，
// 因此这里报 finishReason 与 usage，而不用“有没有正文”判断成败。
console.log(`探测：适配器流式路径 finishReason=${probe.streamed.finishReason ?? '(缺失)'}、usage=${JSON.stringify(probe.streamed.usage)}、完成=${probe.streamed.complete}、正文=${probe.streamed.content || '(空)'}`)
if (options.has('probe-only')) {
  console.log('只做协议探测，未执行任务批次')
  process.exit(0)
}

const spent = { runs: 0, requests: 0, tokens: 0 }
const report = await runPhase(phase, planned.map(id => ({ id })), phaseCaps[phase], async task => {
  const outcome = await runFixtureTask(
    task.id,
    () => ({ provider, model: modelId, capabilities: adapter.capabilities, chat: adapter.chat }),
    evalPolicy,
    path.join(sessionDirectory, task.id),
  )
  spent.runs += 1
  spent.requests += outcome.counters.modelRequests
  spent.tokens += outcome.counters.totalTokens
  // 每跑完一个就落一行：付费批次被中断时不至于连已花掉的部分都取不回来。
  await fs.appendFile(runLog, `${JSON.stringify({ phase, fixture: task.id, ...outcome })}\n`)
  console.log(describe(task.id, outcome, spent, phaseCaps[phase]))
  return outcome
}, record => (infeasible.ids.has(record.task.id) ? { infeasible: true } : undefined))

const summary = { ...summarize(report), model: `${provider}/${modelId}`, baseUrl, contextWindowTokens, probe, ...(infeasible.reason === undefined ? {} : { infeasibleReason: infeasible.reason }) }
await fs.writeFile(reportPath, `${JSON.stringify({ ...summary, runs: report.executed }, null, 2)}\n`)
console.log(`\n汇总：${JSON.stringify(summary)}`)
console.log(`证据：${runLog}\n报告：${reportPath}\n会话：${sessionDirectory}`)
// 未通过验收是评测结果是数据，不是脚本失败；只有整批中止或基础设施失败才让调用方看到非零退出码。
if (report.aborted || summary.rate.excludedErrored > 0) process.exitCode = 1

function parseArguments(argv: string[]) {
  const parsed = new Map<string, string>()
  const flags = new Set(['probe-only'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`)
    const [name, inline] = token.slice(2).split('=', 2)
    if (flags.has(name)) {
      if (inline !== undefined) throw new Error(`--${name} takes no value`)
      parsed.set(name, '')
      continue
    }
    if (!['tasks', 'infeasible', 'infeasible-reason'].includes(name)) throw new Error(`unknown option: --${name}`)
    const value = inline ?? argv[++index]
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`--${name} needs a value`)
    parsed.set(name, value)
  }
  return parsed
}

function resolvePlanned(taskList?: string): FixtureId[] {
  if (taskList === undefined) return [...fixtureIds]
  const requested = taskList.split(',').map(name => name.trim())
  const unknown = requested.filter(name => !fixtureIds.includes(name as FixtureId))
  if (unknown.length) throw new Error(`unknown fixture ids: ${unknown.join(', ')}`)
  if (new Set(requested).size !== requested.length) throw new Error('duplicate fixture ids in --tasks')
  return requested as FixtureId[]
}

// 不可行是人的判断且影响成功率分母，因此必须同时给出理由，否则不允许利用这个口径。
function resolveInfeasible(ids?: string, reason?: string) {
  if (ids === undefined) {
    if (reason !== undefined) throw new Error('--infeasible-reason without --infeasible')
    return { ids: new Set<FixtureId>(), reason: undefined }
  }
  const parsed = resolvePlanned(ids)
  if (reason === undefined || !reason.trim()) throw new Error('--infeasible requires --infeasible-reason explaining why the task is unsolvable as specified')
  return { ids: new Set(parsed), reason: reason.trim() }
}

function resolveModel() {
  const value = process.env.MINI_DSH_EVAL_MODEL ?? process.env.MINI_DSH_MODEL
  if (value === undefined || !value.trim()) throw new Error('MINI_DSH_MODEL is required; refusing to fall back to the adapter default list')
  return value.trim()
}

async function ensureWritable() {
  for (const target of [runLog, reportPath]) {
    try {
      await fs.access(target)
    } catch {
      continue
    }
    throw new Error(`${target} already exists; point MINI_DSH_EVAL_EVIDENCE_DIR at a new directory for a fresh batch`)
  }
  await fs.mkdir(sessionDirectory, { recursive: true })
}

async function probeProtocol() {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('missing DEEPSEEK_API_KEY; copy .env.example to .env and fill it in')
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId, max_tokens: 16, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'reply with the single word: ok' }] }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`probe failed: DeepSeek API ${response.status}: ${await response.text()}`)
  const body: unknown = await response.json()
  const record = body as { model?: string; choices?: { finish_reason?: string }[]; usage?: unknown }
  const streamed = await adapter.chat({ model: modelId, maxOutputTokens: 1024, messages: [{ role: 'user', content: 'reply with the single word: ok' }] })
  return {
    echoedModel: record.model, finishReason: record.choices?.[0]?.finish_reason, usage: record.usage,
    streamed: { content: trimmed(streamed), finishReason: streamed.finishReason, usage: streamed.usage, complete: streamed.complete },
  }
}

function trimmed(response: ChatResponse) {
  return (response.content ?? '').trim().slice(0, 40)
}

function describe(id: FixtureId, outcome: RunOutcome, spent: { runs: number; requests: number; tokens: number }, caps: { requests: number; tokens: number }) {
  const acceptance = outcome.acceptance
  const reason = outcome.error ? `error=${outcome.error}` : acceptance && !acceptance.passed ? `验收退出码=${acceptance.exitCode} protected=${acceptance.protectedFilesChanged.join('|') || '无'}` : ''
  return `[${spent.runs}] ${id}: ${outcome.status} accepted=${outcome.accepted} 请求=${outcome.counters.modelRequests} 工具=${outcome.counters.toolCalls} token=${outcome.counters.totalTokens} ${reason} 累计 ${spent.requests}/${caps.requests} 请求 ${spent.tokens}/${caps.tokens} token`
}
