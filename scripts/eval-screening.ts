import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { armPolicy, evalPolicy, phaseCaps, runPhase, summarize, toolOutputPolicy } from './eval-runner.js'
import type { RunOutcome } from './eval-runner.js'
import type { FixtureId } from './coding-fixtures.js'
import { evidenceScope, parseEvalArguments, phaseRegistry, repeatCount, resolveContextWindow, resolveInfeasible, resolveModel, resolvePlanned, resolveRuns } from './eval-cli.js'
import { runFixtureTask } from './eval-fixture.js'
import { createDeepSeekAdapter } from '../src/models/deepseek.js'
import type { ChatResponse } from '../src/core/contracts.js'

// 真实适配器评测入口。`eval:screening` 是历史命名，现在按 --phase 选择批次（见 eval-runner.ts 的
// phaseCaps）：screening 是 12 个单任务 fixture，sequence 是多阶段 fixture pipeline 的诊断烟测。
// 与 eval-offline 共用同一套运行器与 fixture 驱动，区别只在适配器来源、预算口径（evalPolicy 而非裸
// singleRunBudget）和证据落盘。本脚本会真实计费，默认不做任何干预：不重试、不跳过、不因单次失败中止
// 阶段，只把每步的累计用量打出来供人工决定是否继续。
dotenv.config({ quiet: true })

const repository = fileURLToPath(new URL('../../', import.meta.url))
const options = parseEvalArguments(process.argv.slice(2))
const phase = options.phase
const caps = phaseCaps[phase]

const planned = resolvePlanned(phase, options.tasks)
// 真正会被调度的 run 序列：`planned` 是「跑哪些 fixture」（去重，用于证据目录名与不可行判定），
// `runs` 是展开重复之后的执行清单。两者长度之比就是每个 fixture 的重复数。
const runs = resolveRuns(phase, options.tasks)
const repeats = repeatCount(caps.runs, phaseRegistry(phase).length)
const infeasible = resolveInfeasible(phase, options.infeasible, options.infeasibleReason)
const scope = evidenceScope(phase, planned)
const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
const contextWindowTokens = resolveContextWindow(process.env, baseUrl)
// 对照 A 的两臂只差上下文策略（见 eval-runner.ts 的 armPolicy）；其余阶段用的是两臂共用的 evalPolicy。
const policy = phase === 'armA' || phase === 'armB' ? armPolicy(phase, contextWindowTokens) : evalPolicy
// 对照 B 的自变量是工具输出是否有界（见 eval-runner.ts 的 toolOutputPolicy）。undefined 表示不装载
// tool-results 插件，既有阶段的行为一字不变。
const toolOutput = toolOutputPolicy(phase)

// 证据目录按「阶段 + 覆盖范围」分开放，并一次一跑：烟测的单个任务不会挡住整批，也不会混进整批的
// 记录；同一范围重复运行时直接拒绝写入，避免“整体重跑”被误读成“同一次运行的追加”。
const evidenceDirectory = process.env.MINI_DSH_EVAL_EVIDENCE_DIR ?? path.join(repository, '.eval-evidence', `${phase}-${scope}`)
const sessionDirectory = path.join(evidenceDirectory, 'sessions')
const runLog = path.join(evidenceDirectory, 'runs.jsonl')
const reportPath = path.join(evidenceDirectory, 'report.json')

// 预演排在一切副作用之前：不建目录、不出网、不需要 API key，让「这次要跑什么、上限多少、证据落在哪」
// 能在花钱之前被人核对。它必须早于 ensureWritable 与 probeProtocol，否则“预演”自己就已经花掉了钱。
if (options.planOnly) {
  // 打印的是**会被调度的计划**，不是上限：NX-08e 就是因为这里把 runs 上限当计划印出来，才让「3 次运行」
  // 看起来已经兑现，而实际只跑 1 次。两者现在由构造相等，但说清楚仍然是这个预演存在的理由。
  console.log(`${phase}-${scope}: ${planned.length} 个任务 × ${repeats} 次重复 = ${runs.length} 次运行：${planned.join(', ')}`)
  console.log(`预算：单次 run ${policy.maxModelRequests} 请求 / ${policy.maxToolCalls} 工具 / ${policy.maxActiveDurationMs}ms / ${policy.maxTotalTokens} token；整批 ${caps.requests} 请求 / ${caps.tokens} token，${caps.runs} 次运行`)
  console.log(`上下文：输入目标 ${policy.inputTargetTokens} token（对照 A 的臂间差异只在这里）`)
  // 对照 B 的臂间差异是工具输出模式而不是输入目标，预演里看不见它就等于预演失效——这正是这个分支存在的
  // 理由。只打语义不打数值：具体的预览上限属于驱动侧的实现细节，写在这里会多出第二处需要同步的常量。
  console.log(`工具输出：${toolOutput ? (toolOutput.bounded ? '有界（超出预览上限即截断并落盘，可用 read_tool_result 回读）' : '无界（结果原样进入历史，不截断）') : '不装载 tool-results 插件（既有阶段的行为）'}`)
  console.log(`模型：${process.env.MINI_DSH_EVAL_MODEL ?? process.env.MINI_DSH_MODEL ?? '(未设置)'}；端点：${baseUrl}；窗口：${contextWindowTokens}`)
  console.log(`证据目录：${evidenceDirectory}`)
  console.log('只做计划预演，未建立目录、未发出请求')
  process.exit(0)
}

const model = resolveModel(process.env)
const selection = model.includes('/') ? model.split('/') : ['deepseek', model]
const [provider, modelId] = [selection[0], selection.slice(1).join('/')]
if (provider !== 'deepseek') throw new Error(`only the deepseek provider is wired for paid runs, got: ${provider}`)
if (!modelId) throw new Error('MINI_DSH_MODEL must name a model, e.g. deepseek/deepseek-v4-flash')

const adapter = createDeepSeekAdapter({ baseUrl, models: [modelId], contextWindowTokens })
console.log(`${phase}-${scope}: ${provider}/${modelId} @ ${baseUrl}, window ${contextWindowTokens}, ${planned.length} 个任务 × ${repeats} 次重复 = ${runs.length} 次运行`)
console.log(`预算：单次 run ${policy.maxModelRequests} 请求 / ${policy.maxToolCalls} 工具 / ${policy.maxActiveDurationMs}ms / ${policy.maxTotalTokens} token；整批 ${caps.requests} 请求 / ${caps.tokens} token；输入目标 ${policy.inputTargetTokens}`)

// 先确认这次能落盘再发任何付费请求：证据目录冲突时就该在花钱之前停下。
if (!options.probeOnly) await ensureWritable()

// 花整批的钱之前先用两次极小请求把协议风险排掉：模型名是否被接受、服务端回显的是哪个 model、
// usage 的字段形状、thinking 与流式解析能不能走通。任一不符就在这里停下，不进入整批任务。
const probe = await probeProtocol()
console.log(`探测：回显 model=${probe.echoedModel ?? '(缺失)'}、finish_reason=${probe.finishReason ?? '(缺失)'}、usage=${JSON.stringify(probe.usage)}`)
// 流式探测看的是协议能否走通，不是模型能否作答：thinking 打开时输出额度可能全被推理吃掉，
// 因此这里报 finishReason 与 usage，而不用“有没有正文”判断成败。
console.log(`探测：适配器流式路径 finishReason=${probe.streamed.finishReason ?? '(缺失)'}、usage=${JSON.stringify(probe.streamed.usage)}、完成=${probe.streamed.complete}、正文=${probe.streamed.content || '(空)'}`)
if (options.probeOnly) {
  console.log('只做协议探测，未执行任务批次')
  process.exit(0)
}

const spent = { runs: 0, requests: 0, tokens: 0 }
const report = await runPhase(phase, runs, caps, async task => {
  // 重复之间共用同一个 fixture 子目录：每次运行的 session id 是随机分配的，落盘时天然各占一个子目录，
  // 不会互相覆盖；分辨「第几次重复」靠的是记录里的 repeat 字段，不是目录名。
  const outcome = await runFixtureTask(
    task.id,
    () => ({ provider, model: modelId, capabilities: adapter.capabilities, chat: adapter.chat }),
    policy,
    path.join(sessionDirectory, task.id),
    toolOutput,
  )
  spent.runs += 1
  spent.requests += outcome.counters.modelRequests
  spent.tokens += outcome.counters.totalTokens
  // 每跑完一个就落一行：付费批次被中断时不至于连已花掉的部分都取不回来。
  await fs.appendFile(runLog, `${JSON.stringify({ phase, fixture: task.id, repeat: task.repeat, ...outcome })}\n`)
  console.log(describe(task.id, task.repeat, outcome, spent, caps))
  return outcome
}, record => (infeasible.ids.has(record.task.id) ? { infeasible: true } : undefined))

const summary = { ...summarize(report), model: `${provider}/${modelId}`, baseUrl, contextWindowTokens, inputTargetTokens: policy.inputTargetTokens, probe, ...(infeasible.reason === undefined ? {} : { infeasibleReason: infeasible.reason }) }
await fs.writeFile(reportPath, `${JSON.stringify({ ...summary, runs: report.executed }, null, 2)}\n`)
console.log(`\n汇总：${JSON.stringify(summary)}`)
console.log(`证据：${runLog}\n报告：${reportPath}\n会话：${sessionDirectory}`)
// 未通过验收是评测结果是数据，不是脚本失败；只有整批中止或基础设施失败才让调用方看到非零退出码。
if (report.aborted || summary.rate.excludedErrored > 0) process.exitCode = 1

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

function describe(id: FixtureId, repeat: number, outcome: RunOutcome, spent: { runs: number; requests: number; tokens: number }, limits: { requests: number; tokens: number }) {
  const acceptance = outcome.acceptance
  const reason = outcome.error ? `error=${outcome.error}` : acceptance && !acceptance.passed ? `验收退出码=${acceptance.exitCode} protected=${acceptance.protectedFilesChanged.join('|') || '无'}` : ''
  return `[${spent.runs}] ${id}#${repeat}: ${outcome.status} accepted=${outcome.accepted} 请求=${outcome.counters.modelRequests} 工具=${outcome.counters.toolCalls} token=${outcome.counters.totalTokens} ${reason} 累计 ${spent.requests}/${limits.requests} 请求 ${spent.tokens}/${limits.tokens} token`
}
