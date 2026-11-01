import { spawnSync } from 'node:child_process'
import type { SessionEvent } from './contracts.js'
import type { BudgetPolicy, RunState } from './budget.js'

// 运行中的两类宿主提示，都以 user/message 落盘（可审计、续跑一致、前缀稳定），前缀固定便于从日志复算触发次数。
export const BUDGET_NOTICE_PREFIX = '[harness budget]'
export const COMPLETION_CHECK_PREFIX = '[harness check:'

const BUDGET_LEVELS = [0.35, 0.5, 0.75, 0.9] as const
const BUDGET_ADVICE: Record<(typeof BUDGET_LEVELS)[number], string> = {
  0.35: '',
  0.5: 'Avoid broad exploration from here on; focus on the most likely fix.',
  0.75: 'If you have a candidate fix, apply it now and run one focused check.',
  0.9: 'Finish now: make sure the final change is saved in the files, then stop with a brief summary. Edits already in the files are kept if the budget runs out.',
}

function runMessages(events: readonly SessionEvent[], runId: string, prefix: string) {
  return events.filter(event => event.type === 'user/message' && event.runId === runId && event.data.content.startsWith(prefix))
    .map(event => event.type === 'user/message' ? event.data.content : '')
}

// 留出批 50 题里 4 条空补丁预算停止都是「一直查、从不改」：翻 git 历史、读无关文件直到上限，通用提醒被无视。
// 宿主能确认工作区是否已有改动时，提示改为点名这一点；35% 档只在尚无改动时发。
const NO_PROGRESS_ADVICE = 'No repository file has been changed yet. Stop investigating history or unrelated code; write your best fix into the source files now and refine it afterwards.'

export function budgetNotice(policy: Readonly<BudgetPolicy>, state: RunState, events: readonly SessionEvent[], workspaceChanged?: boolean): string | undefined {
  if (!policy.budgetNotices || policy.maxTotalTokens === undefined) return undefined
  const used = state.counters.totalTokens / policy.maxTotalTokens
  const level = [...BUDGET_LEVELS].reverse().find(threshold => used >= threshold && (threshold !== 0.35 || workspaceChanged === false))
  if (level === undefined) return undefined
  const sent = runMessages(events, state.runId, BUDGET_NOTICE_PREFIX)
  // 一轮跨过多个阈值时只发最高那一档；已发过同档或更高档就不再发。
  if (sent.some(content => Number(/level=(\d+)/.exec(content)?.[1] ?? 0) >= level * 100)) return undefined
  const remaining = Math.max(0, policy.maxTotalTokens - state.counters.totalTokens)
  const lastInput = state.estimatedInputTokens
  const steps = lastInput ? ` At the current context size (~${lastInput} tokens per request) that is roughly ${Math.floor(remaining / Math.max(1, lastInput))} more requests.` : ''
  const advice = workspaceChanged === false && level < 0.9 ? NO_PROGRESS_ADVICE : BUDGET_ADVICE[level]
  return `${BUDGET_NOTICE_PREFIX} level=${level * 100}: about ${Math.round(used * 100)}% of this run's token budget is used; ${remaining} tokens remain.${steps} ${advice}`
}

export interface CompletionCheckInput { workspace: string; events: readonly SessionEvent[]; state: RunState }

function git(workspace: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  return result.status === 0 ? result.stdout : undefined
}

// 工作区是否已有 Agent 改动（宿主结果存储不算）；不是 git 仓库或 git 失败时返回 undefined，不猜。
export function workspaceChanged(workspace: string): boolean | undefined {
  const status = git(workspace, ['status', '--porcelain', '--untracked-files=all'])
  if (status === undefined) return undefined
  return status.split('\n').filter(Boolean).some(line => !line.slice(3).replace(/^"|"$/g, '').startsWith('.mini-dsh/'))
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
    // 留出批 50 题里 full 臂 14 条有补丁的失败中 11 条是目标行为没修全（FAIL_TO_PASS 仍失败）、3 条是回归。
    // 第一次想结束时要求按问题逐条复核一次，并跑改动旁边的现有测试。
    const changed = entries.filter(entry => !(entry.code === '??' && SCRATCH.test(entry.file))).map(entry => entry.file)
    if (changed.length && !sent.includes('review')) {
      return `${COMPLETION_CHECK_PREFIX}review] Before finishing, review the change once: (1) re-read the issue and list every behavior it asks for, including its examples and cases it implies; (2) check that your diff handles each one, and grep for other code paths with the same pattern that need the same fix; (3) run your reproduction and the existing tests closest to the changed files (${changed.slice(0, 5).join(', ')}). Fix anything missing, then stop with a short summary.`
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
