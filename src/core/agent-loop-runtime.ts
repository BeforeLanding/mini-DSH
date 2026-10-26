import { pendingTools } from './pending-tools.js'
import { RunBudgetRuntime } from './run-budget-runtime.js'
import type { Clock } from './run-budget-runtime.js'
import { ContextBudgetRuntime } from './context-runtime.js'
import { CompactionRuntime } from './compaction-runtime.js'
import type { CompactionTrigger, DeclineReason } from './compaction-runtime.js'
import { estimateUsage } from './token-estimator.js'
import { StreamJournal } from './stream-journal.js'
import { TokenObservationCollector, applyTokenCalibration, calibrateTokenEstimate, requestModelLabel, toolSchemaDigest } from './token-calibration.js'
import { ModelStreamError, ProviderError, runErrorData } from './model-error.js'
import { retryDelay, waitForRetry } from './retry-policy.js'
import { systemClock } from './run-budget-runtime.js'
import { ModelNotDispatchedError } from './model-dispatch.js'
import type { BudgetPolicy, RunState, Usage, StopReason } from './budget.js'
import { createHash, randomUUID } from 'node:crypto'
import { BudgetStop } from './budget.js'
import { resolveBudget } from './budget.js'
import type { Agent, RunOptions, ToolSchema } from './contracts.js'
import type { SessionRuntime } from './session-runtime.js'
import type { SystemPromptRuntime } from './system-prompt-runtime.js'
import type { ToolRuntime } from './tool-runtime.js'
import type { LlmRuntime } from './llm-runtime.js'
const CANCELLED_RESULT = 'ToolError: the run was cancelled before this tool ran'
const REQUEST_TOOL = 'read_history'
type Projection = ReturnType<ContextBudgetRuntime['project']>
export class AgentLoopRuntime {
    sessions: Pick<SessionRuntime, keyof SessionRuntime>
    systemPrompt: Pick<SystemPromptRuntime, "assemble">
    tools: Pick<ToolRuntime, "schemas" | "execute" | "renderResult">
    llm: Pick<LlmRuntime, "chat" | "capacity">
    compaction: CompactionRuntime
    constructor({ sessions, systemPrompt, tools, llm }: { sessions: Pick<SessionRuntime, keyof SessionRuntime>; systemPrompt: Pick<SystemPromptRuntime, "assemble">; tools: Pick<ToolRuntime, "schemas" | "execute" | "renderResult">; llm: Pick<LlmRuntime, "chat" | "capacity"> }) {
        this.sessions = sessions
        this.systemPrompt = systemPrompt
        this.tools = tools
        this.llm = llm
        this.compaction = new CompactionRuntime({ sessions, llm })
    }

    clock?: Clock
    random = Math.random
    budget?: import('./budget.js').BudgetPolicy
    async run(agent: Agent, input: string | undefined, { signal, onReasoning, onContent, onToolCall, onToolResult, budget }: RunOptions = {}) {
        const configured = { ...this.budget, ...agent.budget, ...budget }
        const capacity = configured.contextWindowTokens ?? (configured.inputTargetTokens !== undefined ? this.llm.capacity(agent.model) : undefined)
        const policy = resolveBudget(capacity === undefined ? undefined : { contextWindowTokens: capacity }, this.budget, agent.budget, budget)
        const sessionId = agent.sessionId

        const state = this.sessions.beginRun(sessionId, policy, typeof agent.model === 'string' ? agent.model : JSON.stringify(agent.model), input === undefined)
        const control = new RunBudgetRuntime(policy, state, signal, this.clock)
        const enteredTools = new Set<string>()
        let terminalStatus: StopReason | undefined
        let failureStage: 'model' | 'summary' | 'tool' | 'runtime' = 'runtime'
        let activeRequestId: string | undefined
        let activeToolCallId: string | undefined
        let errorRecorded = false
        const observeCommit = (confirmed: boolean, status: StopReason = terminalStatus!) => {
            state.counters.approvalDurationMs = control.approvalDurationMs
            state.counters.activeDurationMs = control.activeDurationMs
            this.sessions.observeTerminalCommit(state, terminalStatus!, confirmed, status)
        }
        const append: SessionRuntime['append'] = (id, type, data) => this.sessions.append(id, type, data, state)
        try {
        if (input !== undefined) append(sessionId, 'user/message', { content: input })

        let step = 0
        // A successful pressure summary can leave an irreducible prefix (for example, an
        // earlier task) above the pressure line. Retrying on every model turn then spends
        // requests on the same condition. Overflow compaction remains available.
        let pressureSuppressed = false

        while (true) {
            step += 1

            control.check()
            if (policy.maxModelRequests !== undefined && state.counters.modelRequests >= policy.maxModelRequests) throw new BudgetStop('max_steps', state)

            const system = await control.wait(() => this.systemPrompt.assemble({
                agent,
                sessionId,
                step,
            }))

            control.check()
            const schemas = this.tools.schemas()
            const schemaDigest = toolSchemaDigest(schemas)
            const modelLabel = requestModelLabel(agent.model)
            // 只从已确认日志中的同模型、同工具 schema 主请求取样；model/start 保留原始估算，
            // 防止把已放大的值反过来训练校准器。每条投影也记录本轮决策，供恢复与审计。
            const calibration = policy.tokenCalibration ? (() => {
                const collector = new TokenObservationCollector()
                for (const event of this.sessions.confirmedEvents(sessionId)) collector.observe(event)
                return calibrateTokenEstimate(collector.observations().filter(observation =>
                    observation.kind === 'main' && observation.model === modelLabel && observation.schemaDigest === schemaDigest),
                    { enabled: true, maxMultiplier: policy.tokenCalibrationMaxMultiplier })
            })() : undefined
            const project = () => new ContextBudgetRuntime().project(this.sessions.visibleEvents(sessionId), state.taskId,
                { system, tools: schemas, maxOutputTokens: policy.maxOutputTokens }, policy, events => this.sessions.deriveMessages(sessionId, events),
                inputTokens => control.outputAllowance(inputTokens), calibration ? raw => applyTokenCalibration(raw, calibration) : undefined)
            let projection = project()
            const absorb = () => { state.removedTaskIds = [...new Set([...state.removedTaskIds, ...projection.removedTaskIds])] }
            absorb()
            control.check()
            // 请求 id 在投影之前生成：溢出检查在两者之间抛出，此处的顺序让“已准备但未发出”的请求在日志里
            // 仍带 id 可辨，而消费端无需依赖投影与 model/start 的相邻位置来判定归属。
            const requestId = randomUUID()
            // 预留输出额度由本处现算而不取 project() 内部那个：project() 在 token_budget 时会把该值降级成 0
            // 并继续返回，而这里要的正是「余额不足就抛」的原语义。
            let maxOutputTokens = 0
            const recordProjection = () => {
                maxOutputTokens = control.outputAllowance(projection.estimatedInputTokens) ?? 0
                append(sessionId, 'context/projection', {
                    requestId, estimatedInputTokens: projection.estimatedInputTokens,
                    ...(calibration ? { rawEstimatedInputTokens: projection.rawEstimatedInputTokens, calibration } : {}),
                    reservedOutputTokens: maxOutputTokens,
                    safetyMarginTokens: projection.safetyMarginTokens, removedTaskIds: projection.removedTaskIds,
                    // NX-39 因子 2 的读数：本轮装配出的系统提示的摘要。投影是「这一轮要发出去的东西」的记录，
                    // 系统提示正是其中一部分，记在这里就不必为了量前缀稳定性再多一条事件类型。
                    systemPromptDigest: createHash('sha256').update(system).digest('hex') })
            }
            recordProjection()

            // NX-34 §4：压缩插在裁剪之后、抛错之前。免费的先做完，贵的才出手。
            const hardInputCapTokens = policy.inputTargetTokens
            const overflowing = () => (hardInputCapTokens !== undefined && projection.estimatedInputTokens > hardInputCapTokens) ||
                (policy.contextWindowTokens !== undefined && projection.estimatedInputTokens + maxOutputTokens + projection.safetyMarginTokens > policy.contextWindowTokens)
            const compactionBudget = policy.compactionBudgetTokens ?? policy.inputTargetTokens
            const attempt = async (trigger: CompactionTrigger) => {
                failureStage = 'summary'
                const applied = await this.#compact(sessionId, state, policy, control, agent, { system, tools: schemas }, trigger, projection)
                failureStage = 'runtime'
                if (!applied) return false
                projection = project()
                absorb()
                control.check()
                // §11：压缩后再记一条投影，让「裁了哪些任务 + 压了哪些 seq」都可追溯。两条共用同一个
                // requestId——它们准备的是同一个请求。
                recordProjection()
                // 摘要调用也是一次模型请求，同样计入该项预算：它用掉最后一次额度，就不该再调度主请求。
                if (policy.maxModelRequests !== undefined && state.counters.modelRequests >= policy.maxModelRequests) throw new BudgetStop('max_steps', state)
                return true
            }
            // pressure 是主路径：装得下但已逼近阈值。它只该做一次——压完还在带内说明这次压缩没解决问题，
            // 再压一遍只是重复花钱。context-overflow 是兜底，按 maxOverflowRetries 限次，防止一步内无限重试。
            const pressureTriggerTokens = compactionBudget === undefined ? undefined : Math.floor(compactionBudget * (policy.compactionRatio ?? 0.8))
            const postCompactionTargetTokens = compactionBudget === undefined ? undefined : Math.floor(compactionBudget * (policy.postCompactionTargetRatio ?? 0.65))
            if (!pressureSuppressed && !overflowing() && pressureTriggerTokens !== undefined && projection.estimatedInputTokens > pressureTriggerTokens) {
                const beforeTokens = projection.estimatedInputTokens
                if (await attempt('pressure')) {
                    const afterTokens = projection.estimatedInputTokens
                    const insufficientReduction = beforeTokens - afterTokens < Math.max(64, Math.ceil(beforeTokens * 0.05))
                    if (insufficientReduction || (postCompactionTargetTokens !== undefined && afterTokens > postCompactionTargetTokens)) {
                        pressureSuppressed = true
                        append(sessionId, 'context/pressure-suppressed', { reason: insufficientReduction ? 'insufficient-reduction' : 'above-target',
                            beforeTokens, afterTokens, targetTokens: postCompactionTargetTokens! })
                    }
                }
            }
            for (let retries = 0; overflowing() && retries < (policy.maxOverflowRetries ?? 1); retries++) {
                if (!await attempt('context-overflow')) break
            }

            const { messages, estimatedInputTokens } = projection
            control.check()
            state.estimatedInputTokens = estimatedInputTokens
            if (overflowing()) throw new BudgetStop('context_overflow', state)
            const settle = (attemptRequestId: string, usage?: Usage) => {
                if (!usage) return
                state.usage.push(usage)
                state.counters.inputTokens += usage.inputTokens
                state.counters.outputTokens += usage.outputTokens
                state.counters.totalTokens += usage.totalTokens
                state.counters.cacheReadTokens += usage.cacheReadTokens ?? 0
                append(sessionId, 'model/usage', { taskId: state.taskId, runId: state.runId, requestId: attemptRequestId, usage })
            }
            let response: Awaited<ReturnType<LlmRuntime['chat']>>
            let attemptRequestId = requestId
            for (let attemptIndex = 0; ; attemptIndex++) {
                append(sessionId, 'model/start', { taskId: state.taskId, runId: state.runId, requestId: attemptRequestId,
                    estimatedInputTokens: projection.rawEstimatedInputTokens, model: modelLabel, schemaDigest })
                await control.wait(() => this.sessions.flush(sessionId))
                control.check()
                state.counters.modelRequests++
                const journal = new StreamJournal(attemptRequestId, data => append(sessionId, 'model/fragment', data))
                failureStage = 'model'
                activeRequestId = attemptRequestId
                try {
                    response = await control.wait(() => this.llm.chat({
                        purpose: 'main', maxOutputTokens, system, messages, tools: schemas, signal: control.signal,
                        dispatchScope: { sessionId, taskId: state.taskId, runId: state.runId, requestId: attemptRequestId },
                        onReasoning: chunk => { if (control.signal.aborted || journal.closed) return; journal.add('reasoning', chunk); onReasoning?.(chunk) },
                        onContent: chunk => { if (control.signal.aborted || journal.closed) return; journal.add('content', chunk); onContent?.(chunk) },
                    }, agent.model), policy.requestTimeoutMs ?? 180_000)
                } catch (error) {
                    journal.close()
                    if (error instanceof ModelNotDispatchedError) {
                        state.counters.modelRequests--
                        append(sessionId, 'model/rejected', { requestId: attemptRequestId, reason: error.reason })
                        errorRecorded = true
                        if (error.reason === 'request_limit') throw new BudgetStop('max_steps', state)
                        throw error
                    }
                    const partial = error instanceof ModelStreamError ? error.partial : { content: journal.content, reasoningContent: journal.reasoningContent, usage: undefined }
                    settle(attemptRequestId, partial.usage ?? estimateUsage(projection.rawEstimatedInputTokens, partial))
                    append(sessionId, 'model/end', { requestId: attemptRequestId, complete: false })
                    const remaining = policy.maxActiveDurationMs === undefined ? Number.POSITIVE_INFINITY : policy.maxActiveDurationMs - control.activeDurationMs
                    const delay = !journal.content && !journal.reasoningContent &&
                        (policy.maxModelRequests === undefined || state.counters.modelRequests < policy.maxModelRequests) &&
                        (policy.maxTotalTokens === undefined || state.counters.totalTokens < policy.maxTotalTokens)
                        ? retryDelay(error, attemptIndex, remaining, this.random) : undefined
                    if (delay !== undefined && error instanceof ProviderError) {
                        const nextRequestId = randomUUID()
                        append(sessionId, 'model/retry', { rootRequestId: requestId, failedRequestId: attemptRequestId, nextRequestId, attempt: attemptIndex + 1, delayMs: delay, errorKind: error.kind })
                        await control.wait(() => this.sessions.flush(sessionId))
                        await waitForRetry(delay, control.signal, this.clock ?? systemClock)
                        control.check()
                        attemptRequestId = nextRequestId
                        continue
                    }
                    append(sessionId, 'run/error', runErrorData('model', error, { requestId: attemptRequestId }))
                    errorRecorded = true
                    throw error
                }
                journal.close()
                settle(attemptRequestId, response.usage ?? estimateUsage(projection.rawEstimatedInputTokens, response))
                append(sessionId, 'model/end', { requestId: attemptRequestId, complete: response.complete !== false, finishReason: response.finishReason })
                break
            }
            failureStage = 'runtime'
            activeRequestId = undefined
            if (response.complete === false) throw new BudgetStop(response.finishReason === 'length' ? 'output_limit' : 'error', state)

            const toolCalls = response.toolCalls ?? []
            if (!toolCalls.length) control.check()

            if (toolCalls.length === 0) {
                const content = response.content ?? ''
                append(sessionId, 'assistant/message', { content, reasoningContent: response.reasoningContent })
                if (policy.maxTotalTokens !== undefined && state.counters.totalTokens > policy.maxTotalTokens) throw new BudgetStop('token_budget', state)
                await control.wait(() => this.sessions.flush(sessionId))
                control.check()
                state.counters.approvalDurationMs = control.approvalDurationMs
                state.counters.activeDurationMs = control.activeDurationMs
                terminalStatus = 'completed'
                this.sessions.finishRun(state, terminalStatus)
                await control.wait(() => this.sessions.flush(sessionId), policy.finalizationTimeoutMs ?? 5_000, 'timeout')
                control.check()
                observeCommit(true)
                return content
            }

            const batch = append(sessionId, 'assistant/tool_calls', {
                content: response.content ?? null,
                reasoningContent: response.reasoningContent,
                toolCalls,
            })

            control.check()
            if (policy.maxModelRequests !== undefined && state.counters.modelRequests >= policy.maxModelRequests) throw new BudgetStop('max_steps', state)
            if (policy.maxTotalTokens !== undefined && state.counters.totalTokens >= policy.maxTotalTokens) {
                const reason = policy.maxToolCalls !== undefined && state.counters.toolCalls >= policy.maxToolCalls ? 'max_tool_calls' : 'token_budget'
                throw new BudgetStop(reason, state)
            }
            let cancelled = false
            let toolsExhausted = false

            for (const call of toolCalls) {
                cancelled ||= Boolean(control.signal.aborted)

                const exhausted = policy.maxToolCalls !== undefined && state.counters.toolCalls >= policy.maxToolCalls
                toolsExhausted ||= exhausted
                if (cancelled || exhausted) {
                    append(sessionId, 'tool/result', {
                        toolCallId: call.id,
                        name: call.name,
                        isError: true,
                        content: cancelled ? CANCELLED_RESULT : 'ToolError: skipped because max_tool_calls budget was exhausted',
                        status: 'skipped',
                    })
                    continue
                }

                onToolCall?.(call)
                control.check()
                append(sessionId, 'tool/start', { taskId: state.taskId, runId: state.runId, toolCallId: call.id, name: call.name })
                await control.wait(() => this.sessions.flush(sessionId))
                control.check()
                state.counters.toolCalls++
                enteredTools.add(`${batch.seq}/${call.id}`)
                failureStage = 'tool'
                activeToolCallId = call.id
                const result = await control.wait(() => this.tools.execute(call.name, call.arguments, {
                    signal: control.signal,
                    sessionId,
                    toolCallId: call.id,
                    toolSequence: batch.seq,
                    agent,
                    approval: work => control.approve(work),
                }))
                // NX-39：与 toolCalls 一样「实时 ++ 且可由事件折叠」两条路径并存，两者必须一致。
                // 这里只可能记 completed 的（跳过与取消在上面的分支里 continue 掉了），与
                // session-runtime 折叠时排除 status 'skipped' 的口径严格对齐。
                if (result.isError) state.counters.toolErrors++
                // 预览截断同理，只是它由结果投影标出、不从 isError 派生：有界档下超限的结果被换成头尾预览
                // 并落盘，无界档下同一条结果逐字进历史。这条计数就是「有界」这一半的触发率来源。
                if (result.previewTruncated) state.counters.previewTruncations++

                const renderedContent = this.tools.renderResult(result)

                append(sessionId, 'tool/result', {
                    toolCallId: call.id,
                    name: call.name,
                    isError: result.isError,
                    content: renderedContent,
                    status: 'completed',
                    // 折叠路径要能重建同一个 previewTruncations，所以这个标记必须落进事件——它不在 content 的
                    // 语义里（content 是给人看的那串文本），靠正则去认它是把渲染细节当契约。
                    ...(result.previewTruncated ? { previewTruncated: true } : {}),
                })
                if (result.isError) append(sessionId, 'run/error', runErrorData('tool', undefined, { toolCallId: call.id }))
                await this.sessions.flush(sessionId)
                failureStage = 'runtime'
                activeToolCallId = undefined
                onToolResult?.({ ...result, renderedContent, name: call.name, toolCallId: call.id })
            }

            if (cancelled) control.check()
            if (toolsExhausted) throw new BudgetStop('max_tool_calls', state)

        }
        } catch (error) {
            if (terminalStatus !== undefined) {
                observeCommit(false, control.stopReason ?? (error instanceof BudgetStop ? error.reason : 'error'))
                throw error
            }
            const events = this.sessions.visibleEvents(sessionId)
            if (!errorRecorded && !(error instanceof BudgetStop && !['timeout', 'request_timeout', 'approval_timeout'].includes(error.reason))) {
                append(sessionId, 'run/error', runErrorData(failureStage, error, { ...(activeRequestId ? { requestId: activeRequestId } : {}), ...(activeToolCallId ? { toolCallId: activeToolCallId } : {}) }))
            }
            for (const { call, scope } of pendingTools(events)) {
                if (scope.runId !== state.runId) continue
                const started = enteredTools.has(`${scope.seq}/${call.id}`)
                append(sessionId, 'tool/result', { toolCallId: call.id, name: call.name, isError: true, status: started ? 'unknown' : 'skipped',
                    content: 'ToolError: ' + (started ? 'unknown outcome' : 'skipped') + ' after ' + (error instanceof BudgetStop ? error.reason : 'error') })
            }
            state.counters.approvalDurationMs = control.approvalDurationMs
                state.counters.activeDurationMs = control.activeDurationMs
            terminalStatus = control.stopReason ?? (error instanceof BudgetStop ? error.reason : 'error')
            this.sessions.finishRun(state, terminalStatus)
            try {
                await control.finalize(() => this.sessions.flush(sessionId))
                observeCommit(true)
            } catch (commitError) {
                observeCommit(false, terminalStatus)
                if (!(commitError instanceof BudgetStop)) throw commitError
            }
            throw error
        } finally { control.dispose() }
    }

    // §8.4：失败闩从**日志折叠**得出，不是内存计数器——这样事后可解释。作用域是当前 run：新 run
    // （含 /continue）重获机会。只有四个摘要内容/调用原因计数；applied 归零；其余原因
    // 说的是「环境变了」，既不计入也不清零。
    #summaryFailures(sessionId: string, state: RunState) {
        const counting = new Set<DeclineReason>(['summary-failed', 'summary-empty', 'summary-invalid', 'summary-not-smaller'])
        let failures = 0
        for (const event of this.sessions.visibleEvents(sessionId)) {
            if (event.type !== 'context/summary-end' || event.runId !== state.runId) continue
            if (event.data.outcome.kind === 'applied') failures = 0
            else if (counting.has(event.data.outcome.reason)) failures += 1
        }
        return failures
    }

    async #compact(sessionId: string, state: RunState, policy: Readonly<BudgetPolicy>, control: RunBudgetRuntime,
        agent: Agent, prompt: { system: string; tools: ToolSchema[] }, trigger: CompactionTrigger, projection: Projection) {
        const budgetTokens = policy.compactionBudgetTokens ?? policy.inputTargetTokens
        if (budgetTokens === undefined) return false
        // explicit 是人在要求，永远可用：它不受失败闩影响，也不被 auto 开关关掉。
        if (trigger !== 'explicit') {
            if (policy.auto === false) return false
            if (this.#summaryFailures(sessionId, state) >= (policy.maxSummaryFailures ?? 2)) return false
        }
        const outcome = await this.compaction.compact({
            sessionId, state, trigger, budgetTokens, projectedTokens: projection.estimatedInputTokens,
            retainRatio: policy.retainRatio ?? 0.16, maxSummaryTokens: policy.compactionMaxTokens ?? 8_192,
            system: prompt.system, tools: prompt.tools, model: agent.model, signal: control.signal,
            check: () => control.check(), outputAllowance: inputTokens => control.outputAllowance(inputTokens),
            retry: {
                remainingMs: () => policy.maxActiveDurationMs === undefined ? Number.POSITIVE_INFINITY : policy.maxActiveDurationMs - control.activeDurationMs,
                wait: delayMs => control.wait(() => waitForRetry(delayMs, control.signal, this.clock ?? systemClock)),
                random: () => this.random(),
            },
            // §7.1：带 seq 范围的 recall 提示只在本部署确实挂载了回读工具时出现——不能承诺一个不存在的入口。
            ...(prompt.tools.some(schema => schema.function.name === REQUEST_TOOL) ? { recallTool: REQUEST_TOOL } : {}),
        })
        return outcome.kind === 'applied'
    }

    // NX-34：CLI `/compact` 的人工入口。压缩刻意**不是**模型可调用的工具——让模型自己决定「我要不要把
    // 看到的上下文压掉」是个坏主意；压缩是人或框架的事，不是模型的事。它开一段维护型 run（复用当前 task
    // 但不承接工作），压缩完即结束，好让这次摘要调用照样计入次数、时间与 token。
    async compact(agent: Agent, options: RunOptions = {}) {
        const configured = { ...this.budget, ...agent.budget, ...options.budget }
        const capacity = configured.contextWindowTokens ?? (configured.inputTargetTokens !== undefined ? this.llm.capacity(agent.model) : undefined)
        const policy = resolveBudget(capacity === undefined ? undefined : { contextWindowTokens: capacity }, this.budget, agent.budget, options.budget)
        const sessionId = agent.sessionId
        const state = this.sessions.beginMaintenanceRun(sessionId, policy, typeof agent.model === 'string' ? agent.model : JSON.stringify(agent.model))
        const control = new RunBudgetRuntime(policy, state, options.signal, this.clock)
        let applied = false
        let terminal: StopReason = 'completed'
        let failure: unknown
        try {
            const system = await control.wait(() => this.systemPrompt.assemble({ agent, sessionId, step: 1 }))
            control.check()
            const schemas = this.tools.schemas()
            const projection = new ContextBudgetRuntime().project(this.sessions.visibleEvents(sessionId), state.taskId,
                { system, tools: schemas, maxOutputTokens: policy.maxOutputTokens }, policy, events => this.sessions.deriveMessages(sessionId, events), inputTokens => control.outputAllowance(inputTokens))
            applied = await this.#compact(sessionId, state, policy, control, agent, { system, tools: schemas }, 'explicit', projection)
        } catch (error) {
            terminal = control.stopReason ?? (error instanceof BudgetStop ? error.reason : 'error')
            failure = error
            this.sessions.append(sessionId, 'run/error', runErrorData('summary', error), state)
        }
        state.counters.approvalDurationMs = control.approvalDurationMs
        state.counters.activeDurationMs = control.activeDurationMs
        control.dispose()
        this.sessions.finishRun(state, terminal)
        try {
            await control.finalize(() => this.sessions.flush(sessionId))
            this.sessions.observeTerminalCommit(state, terminal, true)
        } catch (commitError) {
            this.sessions.observeTerminalCommit(state, terminal, false)
            if (failure === undefined && !(commitError instanceof BudgetStop)) failure = commitError
        }
        if (failure !== undefined) throw failure
        return applied
    }
}
