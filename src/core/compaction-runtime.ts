import { randomUUID } from 'node:crypto'
import { deriveEventMessage, planCompaction, surfaceSeqs } from './compaction-plan.js'
import { estimateMessage } from './message-estimator.js'
import { estimateInput, estimateUsage } from './token-estimator.js'
import type { RunState, Usage } from './budget.js'
import type { ModelSelection, Message, SessionEvent, ToolSchema } from './contracts.js'
import type { SessionRuntime } from './session-runtime.js'
import type { LlmRuntime } from './llm-runtime.js'

export type CompactionTrigger = 'pressure' | 'context-overflow' | 'explicit'
// §5.1 的闭集。前三个计入失败闩，其余说的是「环境变了」而不是「这个摘要器不行」，既不计入也不清零。
export type DeclineReason = 'summary-failed' | 'summary-empty' | 'summary-not-smaller'
  | 'turn-started' | 'plan-stale' | 'agent-gone' | 'cancelled' | 'unclosed'
export type CompactionOutcome =
  | { kind: 'applied'; shadowedSeqs: number[]; summaryTokens: number }
  | { kind: 'declined'; reason: DeclineReason }
  // 没有可压缩的段：**没有尝试**，因此不写括号、不落 declined。R-22 要求此时保留原投影。
  | { kind: 'skipped'; reason: 'nothing-to-plan' }

export interface CompactionAttempt {
  sessionId: string
  state: RunState
  trigger: CompactionTrigger
  // 压缩衡量的预算与触发时估算的输入：summary-start 要如实记下触发判据比较的那个数。
  budgetTokens: number
  projectedTokens: number
  retainRatio: number
  maxSummaryTokens: number
  minShadowedNodes?: number
  system: string
  tools: ToolSchema[]
  model: ModelSelection
  signal: AbortSignal
  // 写 applied 之前复查取消与主动预算。§3.1：不照搬参考实现的 after-await 计划重校验（本仓库的 run
  // 互斥已消掉它防的那个竞态），但这一步必须保留。
  check(): void
  outputAllowance(inputTokens: number): number | undefined
  // 只有确实挂载了回读工具时才填。§7.1：不能承诺一个不存在的入口。
  recallTool?: string
}

// §8.2 的固定八节：形状是为「接着干活」设计的，不是为「回顾」设计的。
// 「合并而非照抄」是「摘要的摘要越来越糊」的正解——第二次摘要拿「旧摘要 + 新内容」**重写一份完整的**，
// 而不是把旧摘要再摘一遍。第二段因此只在区间里确实含有一份更早的摘要时才出现。
const COMPACTION_INSTRUCTION = [
  '上面的对话正在被摘要，以便在上下文窗口内继续工作。',
  '用 Markdown 写摘要，只用简洁的要点，分以下小节，且必须包含具体的文件路径、',
  '标识符、命令和错误原文——读者将**只有**这份摘要和最近的消息。',
  '',
  '## Primary Request',
  '## Key Concepts',
  '## Files and Code',
  '## Errors and Fixes',
  '## Pending Work',
  '## Current Work',
  '## Next Step',
  '## Critical Context',
  '',
  '如果上面已经出现过一份更早的摘要，请把它的内容**合并**进来，不要逐字照抄。',
  '只回复摘要正文。',
].join('\n')

// frame 是**代码写的**，不是模型写的（§7.1）。门牌号让替换可寻址：没有 seq 范围，模型手里就是一段
// 「不知道丢了什么」的摘要，也无从问起。
function buildFrame(summary: string, covered: readonly number[], recallTool?: string) {
  const from = covered[0]!, to = covered.at(-1)!, count = covered.length
  const lines = [
    '<system-reminder>',
    '本次会话的一段历史已被下面的摘要替换，以保持在上下文窗口内。',
    '完整历史仍在会话日志中；只有你能看到的部分变了。从这里继续工作。',
    `第 ${from}–${to} 号事件（共 ${count} 条）是被这些摘要替换掉的。`,
  ]
  if (recallTool) lines.push(`当你需要摘要里缺失的具体事实时，用 ${recallTool} 按范围读回；它有预算，请只读能回答你问题的最窄范围。`)
  lines.push('</system-reminder>', '', summary)
  return lines.join('\n')
}

// 被本区间换掉的**原始**事件并集：区间里若含一份更早的摘要，展开它遮蔽过的那些 seq（§7.1：
// 第二次压缩时门牌号取整个会话的并集，因为第二次会把第一份摘要也遮蔽掉）。
function coveredSeqs(bySeq: Map<number, SessionEvent>, shadowedSeqs: readonly number[]) {
  const covered = new Set<number>()
  for (const seq of shadowedSeqs) {
    const event = bySeq.get(seq)
    if (event?.type === 'context/summary') for (const original of event.data.shadowedSeqs) covered.add(original)
    else covered.add(seq)
  }
  return [...covered].sort((a, b) => a - b)
}

export class CompactionRuntime {
  #sessions: Pick<SessionRuntime, 'visibleEvents' | 'append' | 'flush'>
  #llm: Pick<LlmRuntime, 'chat'>
  constructor({ sessions, llm }: { sessions: Pick<SessionRuntime, 'visibleEvents' | 'append' | 'flush'>; llm: Pick<LlmRuntime, 'chat'> }) {
    this.#sessions = sessions
    this.#llm = llm
  }

  #settle(sessionId: string, state: RunState, requestId: string, usage: Usage, complete: boolean) {
    state.usage.push(usage)
    state.counters.inputTokens += usage.inputTokens
    state.counters.outputTokens += usage.outputTokens
    state.counters.totalTokens += usage.totalTokens
    this.#sessions.append(sessionId, 'model/usage', { taskId: state.taskId, runId: state.runId, requestId, usage }, state)
    this.#sessions.append(sessionId, 'model/end', { requestId, complete }, state)
  }

  #close(sessionId: string, state: RunState, startSeq: number, reason: DeclineReason | undefined) {
    const outcome = reason === undefined ? { kind: 'applied' as const } : { kind: 'declined' as const, reason }
    this.#sessions.append(sessionId, 'context/summary-end', { startSeq, outcome }, state)
    return outcome
  }

  async compact(attempt: CompactionAttempt): Promise<CompactionOutcome> {
    const { sessionId, state } = attempt
    const events = this.#sessions.visibleEvents(sessionId)
    const bySeq = new Map(events.map(event => [event.seq, event]))
    const plan = planCompaction(events, surfaceSeqs(events), {
      budgetTokens: attempt.budgetTokens, retainRatio: attempt.retainRatio,
      ...(attempt.minShadowedNodes === undefined ? {} : { minShadowedNodes: attempt.minShadowedNodes }),
    })
    if (!plan) return { kind: 'skipped', reason: 'nothing-to-plan' }

    // §8.1：原样重放被遮蔽区间派生出的全部消息，system 与 tools 与主循环逐字相同。这不是为了好看——
    // 它让 provider 的前缀缓存能命中（本仓库的 DeepSeek 适配器尚未实现缓存，红利待兑现）。
    const replayed = plan.shadowedSeqs.flatMap(seq => {
      const event = bySeq.get(seq)
      const message = event ? deriveEventMessage(event) : undefined
      return message ? [message] : []
    })
    const messages: Message[] = [...replayed, { role: 'user', content: COMPACTION_INSTRUCTION }]
    const inputTokens = estimateInput({ system: attempt.system, messages, tools: attempt.tools })
    // §8.3：预留输出走既有 outputAllowance；余额不足时它抛 token_budget，**向外传播**，不吞成 decline——
    // 「钱不够」不是「摘要器不行」，混进失败闩就废了。
    const allowance = attempt.outputAllowance(inputTokens)
    const maxOutputTokens = allowance === undefined ? attempt.maxSummaryTokens : Math.min(attempt.maxSummaryTokens, allowance)

    // 括号在调用**之前**写：已经付过钱的尝试必须落盘，否则「试过但失败」在日志里不存在。
    const start = this.#sessions.append(sessionId, 'context/summary-start', {
      trigger: attempt.trigger, budgetTokens: attempt.budgetTokens, projectedTokens: attempt.projectedTokens,
      plannedStart: plan.start, plannedEnd: plan.end, plannedNodes: plan.shadowedSeqs.length,
    }, state)
    // 摘要调用是一次真实的模型调用，按主循环同一形态记账：model/start 使 latestRun 的事件折叠能重建
    // 次数与 token，也让崩溃后的 restore 按既有规则补一条 estimated usage。
    const requestId = randomUUID()
    this.#sessions.append(sessionId, 'model/start', { taskId: state.taskId, runId: state.runId, requestId, estimatedInputTokens: inputTokens }, state)
    state.counters.modelRequests++
    await this.#sessions.flush(sessionId)

    let content: string | undefined
    let failure: unknown
    try {
      const response = await this.#llm.chat({ maxOutputTokens, system: attempt.system, messages, tools: attempt.tools, signal: attempt.signal }, attempt.model)
      content = response.content
      this.#settle(sessionId, state, requestId, response.usage ?? estimateUsage(inputTokens, response), response.complete !== false)
    } catch (error) {
      failure = error
      this.#settle(sessionId, state, requestId, estimateUsage(inputTokens), false)
    }

    // 写 context/summary 之前复查取消与主动预算。§5.1 的闭集里没有 timeout／token_budget，`check()` 抛出的
    // 任何停止原因在此一律归入 `cancelled`——它表达的是「环境变了，这次不算数」。
    let reason: DeclineReason | undefined
    if (attempt.signal.aborted) reason = 'cancelled'
    else try { attempt.check() } catch { reason = 'cancelled' }
    if (reason === undefined) {
      if (failure !== undefined) reason = 'summary-failed'
      else if (!content?.trim()) reason = 'summary-empty'
    }

    if (reason !== undefined) {
      this.#close(sessionId, state, start.seq, reason)
      return { kind: 'declined', reason }
    }

    const summary = content!.trim()
    const frame = buildFrame(summary, coveredSeqs(bySeq, plan.shadowedSeqs), attempt.recallTool)
    // summaryTokens 量的是**替换进去的 frame**，不是模型正文——「摘要有没有让输入变小」的真正比较对象
    // 是替换品与原件，只量正文会把门牌号的成本漏掉。
    const summaryTokens = estimateMessage({ role: 'user', content: frame })
    if (summaryTokens >= plan.shadowedTokens) {
      this.#close(sessionId, state, start.seq, 'summary-not-smaller')
      return { kind: 'declined', reason: 'summary-not-smaller' }
    }

    // 先写摘要正文再闭合括号：投影只依赖 context/summary，不依赖括号；这样崩溃窗口里落地的是
    // 「压缩已生效」而不是「声称 applied 却查无摘要」。
    this.#sessions.append(sessionId, 'context/summary', {
      startSeq: start.seq, trigger: attempt.trigger, budgetTokens: attempt.budgetTokens, projectedTokens: attempt.projectedTokens,
      shadowedSeqs: plan.shadowedSeqs, shadowedTokens: plan.shadowedTokens, summaryTokens,
      retainedNodes: plan.retainedNodes, summary, frame,
    }, state)
    this.#close(sessionId, state, start.seq, undefined)
    return { kind: 'applied', shadowedSeqs: plan.shadowedSeqs, summaryTokens }
  }
}
