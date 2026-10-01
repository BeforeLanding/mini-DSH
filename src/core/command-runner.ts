import { spawn, execFile } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { positiveLimit } from './bounded-text.js'
import { utf8Prefix } from './tool-result-store.js'

export interface CommandStream {
  text: string; bytes: number; truncated: boolean
  ref?: string; storedBytes?: number; storageTruncated?: boolean; previewTruncated?: boolean; storageError?: string
}
export interface CommandResult {
  type: 'command'; version: 1; command: string; cwd: string
  status: 'exited' | 'spawn_error' | 'timed_out' | 'cancelled'
  exitCode: number | null; signal: NodeJS.Signals | null; durationMs: number
  timedOut: boolean; cancelled: boolean; stdout: CommandStream; stderr: CommandStream; error?: string
}
export interface CommandOptions {
  executable: string; args: string[]; command: string; cwd: string; signal: AbortSignal
  timeoutMs?: number; maxCaptureBytes?: number
}

export function commandFailed(result: CommandResult) { return result.status !== 'exited' || result.exitCode !== 0 }

// 等进程树终结的上限（仅 Windows 用得上，见 kill）。taskkill 可能挂住，超限按「尽力而为」放行，
// 不把 runCommand 无限期拖住。取 2 秒而不是收尾预算的 5 秒：这段等待会推迟工具结果与验证账本，
// 与 run 的收尾预算叠加会拉长「run 已终结但事件还在追加」的窗口。
const treeKillDeadlineMs = 2_000

export async function runCommand(options: CommandOptions): Promise<CommandResult> {
  const limit = positiveLimit(options.maxCaptureBytes, 8 * 1024 * 1024, 'maxCaptureBytes')
  const timeoutMs = positiveLimit(options.timeoutMs, 30_000, 'timeoutMs', 2_147_483_647)
  options.signal.throwIfAborted()
  const started = performance.now()
  return new Promise(resolve => {
    const stdout = { chunks: [] as Buffer[], truncated: false }
    const stderr = { chunks: [] as Buffer[], truncated: false }
    let bytes = 0, status: CommandResult['status'] = 'exited', error: string | undefined
    const stream = (target: typeof stdout): CommandStream => {
      const raw = Buffer.concat(target.chunks), kept = utf8Prefix(raw, raw.length)
      // Remove an incomplete UTF-8 suffix when collection cut a character.
      let end = kept.length
      if (target.truncated && end) {
        let lead = end - 1
        while (lead > 0 && (kept[lead] & 0xc0) === 0x80) lead--
        const first = kept[lead], width = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1
        if (end - lead < width) end = lead
      }
      const content = kept.subarray(0, end)
      return { text: content.toString('utf8'), bytes: content.length, truncated: target.truncated }
    }
    const result = (exitCode: number | null, signal: NodeJS.Signals | null): CommandResult => ({
      type: 'command', version: 1, command: options.command, cwd: options.cwd, status,
      exitCode: status === 'spawn_error' ? null : exitCode, signal, durationMs: Math.max(0, performance.now() - started),
      timedOut: status === 'timed_out', cancelled: status === 'cancelled', stdout: stream(stdout), stderr: stream(stderr), ...(error ? { error } : {}),
    })
    let child: ReturnType<typeof spawn>
    try { child = spawn(options.executable, options.args, { cwd: options.cwd, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (cause) { status = 'spawn_error'; error = String(cause); resolve(result(null, null)); return }
    const collect = (target: typeof stdout, chunk: Buffer) => {
      const remaining = limit - bytes
      if (chunk.length > remaining) target.truncated = true
      if (remaining > 0) { const kept = chunk.subarray(0, remaining); target.chunks.push(kept); bytes += kept.length }
    }
    // 杀进程树，返回一个**永不 reject** 的 Promise，表示「树已经收掉了」这件事何时落定。
    // POSIX 上 `kill(-pgid, SIGKILL)` 在系统调用层面同步送达，返回即已送达（SIGKILL 不可捕获，
    // 组内成员不可能再跑自己的定时器），所以直接 resolve。
    // Windows 上没有进程组，树由一个**外部进程** taskkill 异步拆——不等它落定就 resolve，就会出现
    // 「已经返回 cancelled，子进程树还在跑」的窗口：实测 taskkill 往返约 460ms，而调用方可能在
    // 这期间就把终态记成了事实。
    const kill = (): Promise<void> => {
      if (!child.pid) return Promise.resolve()
      if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
        return Promise.resolve()
      }
      return new Promise<void>(settle => {
        let done = false
        const finish = () => { if (!done) { done = true; settle() } }
        const deadline = setTimeout(() => { child.kill(); finish() }, treeKillDeadlineMs)
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, cause => {
          clearTimeout(deadline)
          if (cause) child.kill()
          finish()
        })
      })
    }
    // `status !== 'exited'` 是闩：stop 最多生效一次，terminating 也最多被赋值一次。
    let terminating: Promise<void> | undefined
    const stop = (reason: 'timed_out' | 'cancelled') => {
      if (status !== 'exited') return
      status = reason
      terminating = kill()
    }
    const abort = () => stop('cancelled')
    const timer = setTimeout(() => stop('timed_out'), timeoutMs)
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) abort()
    child.stdout!.on('data', chunk => collect(stdout, chunk))
    child.stderr!.on('data', chunk => collect(stderr, chunk))
    child.on('error', cause => { if (status === 'exited') status = 'spawn_error'; error = cause.message })
    child.on('close', (code, signal) => {
      clearTimeout(timer); options.signal.removeEventListener('abort', abort)
      // 只在下过 kill 时多等一步；正常退出（close 先于任何 stop）路径一行未变。
      // 仍然**只**在 close 上 resolve：deadline 超时也不强行 resolve，否则「resolve 即进程已退」
      // 这条不变式会破，exitCode 与 signal 会变成猜的。
      if (!terminating) return resolve(result(code, signal))
      terminating.then(() => resolve(result(code, signal)))
    })
  })
}
