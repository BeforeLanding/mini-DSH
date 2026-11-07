import path from 'node:path'
import { runCommand } from '../core/command-runner.js'
import { utf8Prefix } from '../core/tool-result-store.js'
import { writeArtifact } from './store.js'
import type { FaultInjector } from './faults.js'
import type { OrchestrationStore } from './store.js'

const LOG_LIMIT = 16 * 1024
const bounded = (text: string) => Buffer.byteLength(text) <= LOG_LIMIT ? text : utf8Prefix(Buffer.from(text), LOG_LIMIT).toString('utf8')
// 验收只在整合 worktree 内运行，证据绑定整合 tree SHA（DEVELOPMENT.md D10、I8）。
// 命令由宿主执行，不经过 worker 的工具审批，也不复用 worker 的任何自述。
export interface VerifyInput {
  store: OrchestrationStore
  worktree: string
  head: string
  tree: string
  commands: readonly string[]
  signal?: AbortSignal
  timeoutMs?: number
  faults?: FaultInjector
}
export async function verifyIntegration(input: VerifyInput) {
  const commands = [...new Set(input.commands.map(command => command.trim()).filter(Boolean))]
  const results: { command: string; exitCode: number | null; logRef?: string }[] = []
  let passed = true
  for (const command of commands) {
    const timeoutMs = input.timeoutMs ?? 600_000
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    const result = await runCommand({
      executable: process.platform === 'win32' ? 'bash' : '/bin/sh', args: ['-c', command], command,
      cwd: input.worktree, signal, timeoutMs, maxCaptureBytes: 64 * 1024,
    })
    const exitCode = result.status === 'exited' ? result.exitCode : null
    const artifact = await writeArtifact(path.join(input.store.directory, 'artifacts'), {
      head: input.head, tree: input.tree, command, cwd: input.worktree, status: result.status,
      exitCode, signal: result.signal, durationMs: result.durationMs,
      stdout: bounded(result.stdout.text), stdoutTruncated: result.stdout.truncated,
      stderr: bounded(result.stderr.text), stderrTruncated: result.stderr.truncated,
      ...(result.error ? { error: result.error } : {}),
    })
    // 崩溃点位于命令已运行、证据未落盘：恢复时必须重新运行，旧日志不复用。
    await input.faults?.checkpoint('after-verify-command')
    await input.store.append('verification/finished', { head: input.head, tree: input.tree, command, exitCode, logRef: artifact.ref })
    results.push({ command, exitCode, logRef: artifact.ref })
    if (exitCode !== 0) passed = false
  }
  return { passed, results }
}
