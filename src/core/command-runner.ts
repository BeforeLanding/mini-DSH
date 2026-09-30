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
    const kill = () => {
      if (!child.pid) return
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, cause => { if (cause) child.kill() })
      else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    }
    const stop = (reason: 'timed_out' | 'cancelled') => { if (status !== 'exited') return; status = reason; kill() }
    const abort = () => stop('cancelled')
    const timer = setTimeout(() => stop('timed_out'), timeoutMs)
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) abort()
    child.stdout!.on('data', chunk => collect(stdout, chunk))
    child.stderr!.on('data', chunk => collect(stderr, chunk))
    child.on('error', cause => { if (status === 'exited') status = 'spawn_error'; error = cause.message })
    child.on('close', (code, signal) => {
      clearTimeout(timer); options.signal.removeEventListener('abort', abort)
      resolve(result(code, signal))
    })
  })
}
