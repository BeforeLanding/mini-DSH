import { spawnSync } from 'node:child_process'
import type { SessionEvent } from './contracts.js'
import type { BudgetPolicy, RunState } from './budget.js'

// 运行中的两类宿主提示，都以 user/message 落盘（可审计、续跑一致、前缀稳定），前缀固定便于从日志复算触发次数。
export const BUDGET_NOTICE_PREFIX = '[harness budget]'
export const COMPLETION_CHECK_PREFIX = '[harness check:'

const BUDGET_LEVELS = [0.5, 0.75, 0.9] as const
const BUDGET_ADVICE: Record<(typeof BUDGET_LEVELS)[number], string> = {
  0.5: 'Avoid broad exploration from here on; focus on the most likely fix.',
  0.75: 'If you have a candidate fix, apply it now and run one focused check.',
  0.9: 'Finish now: make sure the final change is saved in the files, then stop with a brief summary. Edits already in the files are kept if the budget runs out.',
}

function runMessages(events: readonly SessionEvent[], runId: string, prefix: string) {
  return events.filter(event => event.type === 'user/message' && event.runId === runId && event.data.content.startsWith(prefix))
    .map(event => event.type === 'user/message' ? event.data.content : '')
}

export function budgetNotice(policy: Readonly<BudgetPolicy>, state: RunState, events: readonly SessionEvent[]): string | undefined {
  if (!policy.budgetNotices || policy.maxTotalTokens === undefined) return undefined
  const used = state.counters.totalTokens / policy.maxTotalTokens
  const level = [...BUDGET_LEVELS].reverse().find(threshold => used >= threshold)
  if (level === undefined) return undefined
  const sent = runMessages(events, state.runId, BUDGET_NOTICE_PREFIX)
  // 一轮跨过多个阈值时只发最高那一档；已发过同档或更高档就不再发。
  if (sent.some(content => Number(/level=(\d+)/.exec(content)?.[1] ?? 0) >= level * 100)) return undefined
  const remaining = Math.max(0, policy.maxTotalTokens - state.counters.totalTokens)
  const lastInput = state.estimatedInputTokens
  const steps = lastInput ? ` At the current context size (~${lastInput} tokens per request) that is roughly ${Math.floor(remaining / Math.max(1, lastInput))} more requests.` : ''
  return `${BUDGET_NOTICE_PREFIX} level=${level * 100}: about ${Math.round(used * 100)}% of this run's token budget is used; ${remaining} tokens remain.${steps} ${BUDGET_ADVICE[level]}`
}

export interface CompletionCheckInput { workspace: string; events: readonly SessionEvent[]; state: RunState }

function git(workspace: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  return result.status === 0 ? result.stdout : undefined
}

const SCRATCH = /(^|\/)(repro|reproduce|reproduction|scratch|tmp|temp|debug|test_issue|check_)[^/]*$|(^|\/)\.tmp/i

// 只看宿主自己能确认的事实：git 工作区差异与本 run 的事件顺序。每类提醒每个 run 最多一次。
export function completionCheck({ workspace, events, state }: CompletionCheckInput): string | undefined {
  const sent = runMessages(events, state.runId, COMPLETION_CHECK_PREFIX).map(content => /^\[harness check:([a-z-]+)\]/.exec(content)?.[1])
  const status = git(workspace, ['status', '--porcelain', '--untracked-files=all'])
  if (status !== undefined) {
    const entries = status.split('\n').filter(Boolean).map(line => ({ code: line.slice(0, 2), file: line.slice(3).replace(/^"|"$/g, '') }))
      .filter(entry => !entry.file.startsWith('.mini-dsh/'))
    if (!entries.length && !sent.includes('no-changes')) {
      return `${COMPLETION_CHECK_PREFIX}no-changes] The workspace has no file changes. If the task needs a code change, make it in the files now; if no change is needed, say so explicitly and stop.`
    }
    const scratch = entries.filter(entry => entry.code === '??' && SCRATCH.test(entry.file)).map(entry => entry.file)
    if (scratch.length && !sent.includes('scratch-files')) {
      return `${COMPLETION_CHECK_PREFIX}scratch-files] These new files look like temporary scripts and would be part of the final change: ${scratch.slice(0, 10).join(', ')}. Delete them unless they are intended parts of the fix, then stop.`
    }
  }
  const inRun = events.filter(event => event.runId === state.runId)
  const lastEdit = Math.max(0, ...inRun.filter(event => event.type === 'file/change').map(event => event.seq))
  const lastCommand = Math.max(0, ...inRun.filter(event => event.type === 'tool/start' && event.data.name === 'bash').map(event => event.seq))
  if (lastEdit > lastCommand && !sent.includes('unverified-edit')) {
    return `${COMPLETION_CHECK_PREFIX}unverified-edit] Files were edited after the last command you ran. Run a focused check of the change (a small reproduction or the most relevant existing tests) before finishing, or state why it cannot be run.`
  }
  return undefined
}
