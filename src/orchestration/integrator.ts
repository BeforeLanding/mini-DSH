import { randomUUID } from 'node:crypto'
import {
  cherryPick, cherryPickAbort, commitAll, headCommit, resetSoft, stageAll, stagedChangedFiles, treeOf, unmergedFiles,
} from './git.js'
import type { GitRunOptions } from './git.js'
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
  const integrationId = `ig_${randomUUID()}`
  const options: GitRunOptions = input.signal ? { signal: input.signal } : {}
  await input.store.append('integration/started', { integrationId, wave: input.wave, baseCommit: input.baseCommit })
  const integration = await input.manager.createIntegration(input.baseCommit)
  const applied: { attemptId: string; sourceCommit: string; commit: string }[] = []
  const skipped = new Set(input.alreadyApplied ?? [])
  for (const attempt of input.attempts) {
    if (skipped.has(attempt.attemptId)) continue
    const picked = await cherryPick(integration.path, attempt.commit, options)
    if (!picked.ok) {
      const files = await unmergedFiles(integration.path)
      await cherryPickAbort(integration.path)
      await input.store.append('integration/conflict', { integrationId, attemptId: attempt.attemptId, files: files.length ? files : ['(unknown)'] })
      return { status: 'blocked' as const, integrationId, applied, conflict: { attemptId: attempt.attemptId, files } }
    }
    const commit = await headCommit(integration.path)
    await input.store.append('integration/applied', { integrationId, attemptId: attempt.attemptId, sourceCommit: attempt.commit, commit })
    applied.push({ attemptId: attempt.attemptId, sourceCommit: attempt.commit, commit })
  }
  const head = await headCommit(integration.path), tree = await treeOf(integration.path, head)
  await input.store.append('integration/finished', { integrationId, head, tree })
  return { status: 'finished' as const, integrationId, head, tree, applied }
}
