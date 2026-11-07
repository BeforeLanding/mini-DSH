import fs from 'node:fs/promises'
import path from 'node:path'
import { commandFailed, runCommand } from '../core/command-runner.js'
import { assertRootId } from './store.js'
import {
  branchExists, deleteBranch, headCommit, listBranches, statusPorcelain, worktreeAdd,
  worktreeAddDetached, worktreeCheckout, worktreeList, worktreePrune, worktreeRemove,
} from './git.js'

// 目录布局（DEVELOPMENT.md §5.4）：编排目录在仓库外，避免被 glob 扫到或嵌套进用户工作树。
export interface WorktreeLayout {
  root: string
  worktrees: string
  base: string
  integration: string
  attempt(attemptId: string): string
  plannerSession(sessionId: string): string
  attemptSession(attemptId: string, sessionId: string): string
}
export function worktreeLayout(rootDirectory: string): WorktreeLayout {
  const root = path.resolve(rootDirectory), worktrees = path.join(root, 'worktrees')
  return {
    root, worktrees, base: path.join(worktrees, 'base'), integration: path.join(worktrees, 'integration'),
    attempt: attemptId => path.join(worktrees, attemptId),
    plannerSession: sessionId => path.join(root, 'sessions', 'planner', sessionId),
    attemptSession: (attemptId, sessionId) => path.join(root, 'sessions', attemptId, sessionId),
  }
}
export const rootShort = (rootId: string) => {
  assertRootId(rootId)
  return rootId.slice(3, 11)
}
export function attemptBranch(rootId: string, subtaskId: string, epoch: number) {
  if (!/^st-[1-9][0-9]{0,2}$/.test(subtaskId)) throw new Error('invalid subtask id for branch name')
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('invalid attempt epoch')
  return `mini-dsh/${rootShort(rootId)}/${subtaskId}-${epoch}`
}
export function integrationBranchName(rootId: string) {
  return `mini-dsh/${rootShort(rootId)}/integration`
}
export interface WorktreeManagerOptions { signal?: AbortSignal; prepareCommand?: string; prepareTimeoutMs?: number }
export class WorktreeManager {
  readonly layout: WorktreeLayout
  constructor(readonly repository: string, readonly rootId: string, rootDirectory: string, private options: WorktreeManagerOptions = {}) {
    this.layout = worktreeLayout(rootDirectory)
  }
  async assertClean(options: { allowDirty?: boolean } = {}) {
    const dirty = await statusPorcelain(this.repository)
    if (dirty.length && !options.allowDirty) throw new Error(`repository has ${dirty.length} uncommitted change(s); orchestration requires a clean worktree (use --allow-dirty to opt in)`)
    return { baseCommit: await headCommit(this.repository), dirty: dirty.length }
  }
  async createBaseSnapshot(baseCommit: string) {
    await fs.mkdir(this.layout.worktrees, { recursive: true, mode: 0o700 })
    await worktreeAddDetached(this.repository, this.layout.base, baseCommit, this.#gitOptions())
    return this.layout.base
  }
  async createAttempt(input: { attemptId: string; subtaskId: string; epoch: number; baseCommit: string }) {
    const branch = attemptBranch(this.rootId, input.subtaskId, input.epoch)
    if (await branchExists(this.repository, branch)) throw new Error(`orchestration branch already exists: ${branch}`)
    await fs.mkdir(this.layout.worktrees, { recursive: true, mode: 0o700 })
    const target = this.layout.attempt(input.attemptId)
    await worktreeAdd(this.repository, target, branch, input.baseCommit, this.#gitOptions())
    return { path: target, branch }
  }
  async createIntegration(baseCommit: string) {
    const branch = integrationBranchName(this.rootId)
    if (await branchExists(this.repository, branch)) throw new Error(`integration branch already exists: ${branch}`)
    await fs.mkdir(this.layout.worktrees, { recursive: true, mode: 0o700 })
    await worktreeAdd(this.repository, this.layout.integration, branch, baseCommit, this.#gitOptions())
    return { path: this.layout.integration, branch }
  }
  // 跨波次复用同一整合分支；worktree 目录仍在时直接使用，缺失时从分支重新挂载。
  async ensureIntegration(baseCommit: string) {
    const branch = integrationBranchName(this.rootId)
    await fs.mkdir(this.layout.worktrees, { recursive: true, mode: 0o700 })
    if (!(await branchExists(this.repository, branch))) {
      await worktreeAdd(this.repository, this.layout.integration, branch, baseCommit, this.#gitOptions())
      return { path: this.layout.integration, branch, baseCommit }
    }
    if (!(await fs.stat(this.layout.integration).catch(() => undefined))) await worktreeCheckout(this.repository, this.layout.integration, branch, this.#gitOptions())
    return { path: this.layout.integration, branch, baseCommit: await headCommit(this.layout.integration) }
  }
  async prepare(worktree: string) {
    const command = this.options.prepareCommand?.trim()
    if (!command) return
    const timeoutMs = this.options.prepareTimeoutMs ?? 600_000
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    const result = await runCommand({
      executable: process.platform === 'win32' ? 'bash' : '/bin/sh', args: ['-c', command], command,
      cwd: worktree, signal, timeoutMs,
    })
    if (commandFailed(result)) {
      const detail = result.stderr.text.trim().slice(0, 1024) || result.error
      throw new Error(`prepare command failed (${result.status}${result.exitCode === null ? '' : ` ${result.exitCode}`})${detail ? `: ${detail}` : ''}`)
    }
  }
  // 只清理本根任务目录下的 worktree 与 mini-dsh/<root8>/* 分支；不碰用户检查出的分支。
  async cleanup() {
    const prefix = path.resolve(this.layout.worktrees) + path.sep
    for (const target of await worktreeList(this.repository)) {
      if (!(target + path.sep).startsWith(prefix)) continue
      if (await fs.stat(target).catch(() => undefined)) await worktreeRemove(this.repository, target)
    }
    await worktreePrune(this.repository)
    for (const branch of await listBranches(this.repository, `mini-dsh/${rootShort(this.rootId)}/*`)) await deleteBranch(this.repository, branch)
    await fs.rm(this.layout.worktrees, { recursive: true, force: true })
  }
  #gitOptions() { return this.options.signal ? { signal: this.options.signal } : {} }
}
