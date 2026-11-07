import { randomUUID } from 'node:crypto'
import {
  cherryPick, cherryPickAbort, commitAll, headCommit, resetSoft, stageAll, stagedChangedFiles, treeOf, unmergedFiles,
} from './git.js'
import type { GitRunOptions } from './git.js'
import type { FaultInjector } from './faults.js'
import type { OrchestrationStore } from './store.js'
import type { WorktreeManager } from './worktrees.js'

export const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '')
const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
// 写集条目要么是文件（精确匹配），要么是以 / 结尾的目录前缀。目录前缀不包含自身以下的词法捷径：
// 路径已在计划校验里规范化，这里只做覆盖判断。
export function writeSetCovers(file: string, writeSet: readonly string[]) {
  const target = comparable(normalizePath(file))
  return writeSet.some(entry => {
    const normalized = comparable(normalizePath(entry))
    return normalized.endsWith('/') ? target.startsWith(normalized) : target === normalized
  })
}
export function findScopeViolations(changedFiles: readonly string[], writeSet: readonly string[]) {
  return changedFiles.filter(file => !writeSetCovers(file, writeSet))
}
export interface CollectInput {
  worktree: string
  baseCommit: string
  writeSet: readonly string[]
  rootId: string
  attemptId: string
  subtaskId: string
  signal?: AbortSignal
}
export async function collectAndCommit(input: CollectInput) {
  const options: GitRunOptions = input.signal ? { signal: input.signal } : {}
  // Worker 本不该提交；若它仍然提交了，把 attempt 分支软回到基线后由宿主重新提交。
  // 这样整合对象始终是带 trailer 的单一宿主提交，恢复时不依赖 worker 的提交习惯。
  if (await headCommit(input.worktree) !== input.baseCommit) await resetSoft(input.worktree, input.baseCommit)
  await stageAll(input.worktree, options)
  const changedFiles = (await stagedChangedFiles(input.worktree, input.baseCommit, options)).map(normalizePath)
  const scopeViolations = findScopeViolations(changedFiles, input.writeSet)
  if (!changedFiles.length) return { outcome: 'no_changes' as const, changedFiles, scopeViolations }
  if (scopeViolations.length) return { outcome: 'scope_violation' as const, changedFiles, scopeViolations }
  const commit = await commitAll(input.worktree, `mini-dsh: ${input.subtaskId}`, [
    `Mini-DSH-Root: ${input.rootId}`, `Mini-DSH-Attempt: ${input.attemptId}`, `Mini-DSH-Subtask: ${input.subtaskId}`,
  ], options)
  return { outcome: 'succeeded' as const, changedFiles, scopeViolations, commit, tree: await treeOf(input.worktree, commit) }
}
export interface IntegrationAttempt { attemptId: string; subtaskId: string; commit: string }
export interface OpenIntegrationInput {
  store: OrchestrationStore
  manager: WorktreeManager
  baseCommit: string
  wave: number
  signal?: AbortSignal
}
// 跨波次复用同一整合分支：首次从 baseCommit 创建，之后从既有分支的 head 继续。
export async function openIntegration(input: OpenIntegrationInput) {
  const integrationId = `ig_${randomUUID()}`
  const opened = await input.manager.ensureIntegration(input.baseCommit)
  await input.store.append('integration/started', { integrationId, wave: input.wave, baseCommit: opened.baseCommit })
  return { integrationId, path: opened.path, baseCommit: opened.baseCommit }
}
export interface ApplyIntegrationInput {
  store: OrchestrationStore
  integrationId: string
  path: string
  attempt: IntegrationAttempt
  signal?: AbortSignal
  faults?: FaultInjector
}
export async function applyAttempt(input: ApplyIntegrationInput) {
  const options: GitRunOptions = input.signal ? { signal: input.signal } : {}
  const picked = await cherryPick(input.path, input.attempt.commit, options)
  if (!picked.ok) {
    const files = await unmergedFiles(input.path)
    await cherryPickAbort(input.path)
    await input.store.append('integration/conflict', { integrationId: input.integrationId, attemptId: input.attempt.attemptId, files: files.length ? files : ['(unknown)'] })
    return { status: 'conflict' as const, conflict: { attemptId: input.attempt.attemptId, files } }
  }
  // 崩溃点位于 cherry-pick 成功之后、applied 事件落盘之前：整合分支已有提交，日志不知道。
  // 恢复时从 integration/started 的基线重放 applied 记录，再重新应用未记录的 attempt。
  await input.faults?.checkpoint('after-cherry-pick')
  const commit = await headCommit(input.path)
  await input.store.append('integration/applied', {
    integrationId: input.integrationId, attemptId: input.attempt.attemptId, sourceCommit: input.attempt.commit, commit,
  })
  return { status: 'applied' as const, commit }
}
export async function finishIntegration(input: { store: OrchestrationStore; integrationId: string; path: string }) {
  const head = await headCommit(input.path), tree = await treeOf(input.path, head)
  await input.store.append('integration/finished', { integrationId: input.integrationId, head, tree })
  return { head, tree }
}
// 单波次的便捷入口；冲突即停并返回 blocked，由编排器决定人工处置。
export interface IntegrateInput {
  store: OrchestrationStore
  manager: WorktreeManager
  baseCommit: string
  wave: number
  attempts: readonly IntegrationAttempt[]
  alreadyApplied?: readonly string[]
  signal?: AbortSignal
}
export async function integrateAttempts(input: IntegrateInput) {
  const opened = await openIntegration(input)
  const applied: { attemptId: string; sourceCommit: string; commit: string }[] = []
  const skipped = new Set(input.alreadyApplied ?? [])
  for (const attempt of input.attempts) {
    if (skipped.has(attempt.attemptId)) continue
    const result = await applyAttempt({
      store: input.store, integrationId: opened.integrationId, path: opened.path, attempt,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (result.status === 'conflict') {
      return { status: 'blocked' as const, integrationId: opened.integrationId, applied, conflict: result.conflict }
    }
    applied.push({ attemptId: attempt.attemptId, sourceCommit: attempt.commit, commit: result.commit })
  }
  const finished = await finishIntegration({ store: input.store, integrationId: opened.integrationId, path: opened.path })
  return { status: 'finished' as const, integrationId: opened.integrationId, ...finished, applied }
}
