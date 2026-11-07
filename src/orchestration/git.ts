import path from 'node:path'
import { runCommand } from '../core/command-runner.js'
import type { CommandResult } from '../core/command-runner.js'

// 有界 git 调用：所有宿主 git 操作都经过这里，统一超时、输出上限与错误形状。
// 不读写用户的 git 配置；提交身份用 -c 临时传入，工作树与分支都由调用方命名。
export interface GitRunOptions { signal?: AbortSignal; timeoutMs?: number; maxCaptureBytes?: number }
export class GitCommandError extends Error {
  constructor(readonly args: readonly string[], readonly result: CommandResult) {
    const stderr = result.stderr.text.trim().slice(0, 4096)
    super(`git ${args.join(' ')} failed (${result.status}${result.exitCode === null ? '' : ` ${result.exitCode}`})${stderr ? `: ${stderr}` : ''}`)
    this.name = 'GitCommandError'
  }
}
export async function runGit(repository: string, args: string[], options: GitRunOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  return runCommand({
    executable: 'git', args, command: `git ${args.join(' ')}`, cwd: repository, signal, timeoutMs,
    maxCaptureBytes: options.maxCaptureBytes ?? 4 * 1024 * 1024,
  })
}
export async function git(repository: string, args: string[], options: GitRunOptions = {}) {
  const result = await runGit(repository, args, options)
  if (result.status !== 'exited' || result.exitCode !== 0) throw new GitCommandError(args, result)
  return result.stdout.text
}
const trimLine = (text: string) => text.trim().split(/\r?\n/).at(-1) ?? ''

export async function repositoryRoot(directory: string) {
  return path.resolve(trimLine(await git(directory, ['rev-parse', '--show-toplevel'])))
}
export async function headCommit(repository: string) {
  return trimLine(await git(repository, ['rev-parse', 'HEAD']))
}
export async function treeOf(repository: string, revision: string) {
  return trimLine(await git(repository, ['rev-parse', `${revision}^{tree}`]))
}
export async function statusPorcelain(repository: string) {
  const text = await git(repository, ['status', '--porcelain=v1', '--untracked-files=normal'])
  return text.split(/\r?\n/).filter(line => line.length > 0)
}
export async function branchExists(repository: string, branch: string) {
  const args = ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]
  const result = await runGit(repository, args)
  if (result.status === 'exited' && result.exitCode === 0) return true
  if (result.status === 'exited' && result.exitCode === 1) return false
  throw new GitCommandError(args, result)
}
export async function worktreeAdd(repository: string, target: string, branch: string, startPoint: string, options: GitRunOptions = {}) {
  await git(repository, ['worktree', 'add', '-b', branch, target, startPoint], options)
}
export async function worktreeAddDetached(repository: string, target: string, startPoint: string, options: GitRunOptions = {}) {
  await git(repository, ['worktree', 'add', '--detach', target, startPoint], options)
}
export async function worktreeList(repository: string) {
  const text = await git(repository, ['worktree', 'list', '--porcelain'])
  return text.split(/\r?\n\r?\n/).flatMap(block => {
    const first = block.split(/\r?\n/).find(line => line.startsWith('worktree '))
    return first ? [path.resolve(first.slice('worktree '.length))] : []
  })
}
export async function worktreeRemove(repository: string, target: string) {
  await git(repository, ['worktree', 'remove', '--force', target])
}
export async function worktreePrune(repository: string) {
  await git(repository, ['worktree', 'prune'])
}
export async function stageAll(worktree: string, options: GitRunOptions = {}) {
  await git(worktree, ['add', '-A'], options)
}
// --no-renames 让重命名的两侧都出现在名单里：写集检查必须同时看到删除与新增。
export async function stagedChangedFiles(worktree: string, baseCommit: string, options: GitRunOptions = {}) {
  const text = await git(worktree, ['diff', '--cached', '--name-only', '--no-renames', '-z', baseCommit], options)
  return text.split('\0').filter(Boolean)
}
export async function commitAll(worktree: string, message: string, trailers: string[] = [], options: GitRunOptions = {}) {
  const body = trailers.length ? `${message.trimEnd()}\n\n${trailers.join('\n')}` : message
  await git(worktree, ['-c', 'user.name=mini-dsh', '-c', 'user.email=mini-dsh@localhost', 'commit', '--no-verify', '-m', body], options)
  return headCommit(worktree)
}
export async function findCommitByTrailer(repository: string, revision: string, attemptId: string) {
  const text = await git(repository, ['log', '--format=%H', '--fixed-strings', '--grep', `Mini-DSH-Attempt: ${attemptId}`, '-1', revision])
  const commit = trimLine(text)
  return /^[a-f0-9]{7,64}$/.test(commit) ? commit : undefined
}
// cherry-pick 会创建新提交，必须与宿主提交使用同一临时身份；否则临时 HOME 下没有 user.email。
export async function cherryPick(worktree: string, commit: string, options: GitRunOptions = {}) {
  const args = ['-c', 'user.name=mini-dsh', '-c', 'user.email=mini-dsh@localhost', 'cherry-pick', '-x', commit]
  const result = await runGit(worktree, args, options)
  return { ok: result.status === 'exited' && result.exitCode === 0, result, args }
}
export async function cherryPickInProgress(worktree: string) {
  const result = await runGit(worktree, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD'])
  return result.status === 'exited' && result.exitCode === 0
}
export async function unmergedFiles(worktree: string) {
  const text = await git(worktree, ['diff', '--name-only', '--diff-filter=U', '-z'])
  return text.split('\0').filter(Boolean)
}
export async function cherryPickAbort(worktree: string) {
  const result = await runGit(worktree, ['cherry-pick', '--abort'])
  if (result.status !== 'exited' || result.exitCode !== 0) throw new GitCommandError(['cherry-pick', '--abort'], result)
}
export async function resetHard(worktree: string, revision: string) {
  await git(worktree, ['reset', '--hard', revision])
}
export async function resetSoft(worktree: string, revision: string) {
  await git(worktree, ['reset', '--soft', revision])
}
export async function listBranches(repository: string, pattern: string) {
  const text = await git(repository, ['branch', '--list', pattern, '--format=%(refname:short)'])
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}
export async function deleteBranch(repository: string, branch: string) {
  if (!/^mini-dsh\/[A-Za-z0-9._/-]+$/.test(branch)) throw new Error('refusing to delete a branch outside the orchestration namespace')
  await git(repository, ['branch', '-D', branch])
}
