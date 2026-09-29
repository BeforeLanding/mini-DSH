import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, Arguments } from '../core/contracts.js'
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { positiveLimit } from '../core/bounded-text.js'

export const name = 'mini-tool-bash'
export const inject = ['tools', 'sandbox']

export function apply(ctx: Context, config: { executable?: string; workspace?: string; maxCaptureBytes?: number } = {}) {
  const workspace = ctx.sandbox.workspace
  const maxCaptureBytes = positiveLimit(config.maxCaptureBytes, 8 * 1024 * 1024, 'maxCaptureBytes')
  const gitBash = path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe')
  const executable = config.executable ?? (process.platform === 'win32' && fs.existsSync(gitBash) ? gitBash : 'bash')
  ctx.effect(() => ctx.tools.register({
    name: 'bash', description: 'Run a bash command in the workspace after approval. Large logs have bounded collection; stored previews include a ref for read_tool_result when available.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    async execute({ command }, exec) {
      if (typeof command !== 'string' || !command.trim()) throw new Error('command is required')
      ctx.sandbox.assertCommand(command)
      await ctx.sandbox.approve({ tool: 'bash', summary: `bash: ${command}`, signal: exec.signal, approval: exec.approval })
      ctx.sandbox.assertCommand(command)
      exec.signal.throwIfAborted()
      return new Promise<string>((resolve, reject) => {
        const child = spawn(executable, ['-lc', command], { cwd: workspace, windowsHide: true,
          detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
        const chunks: Buffer[] = []
        let bytes = 0
        let truncated = false
        let failure: Error | undefined
        const collect = (chunk: Buffer) => {
          const remaining = maxCaptureBytes - bytes
          if (chunk.length > remaining) truncated = true
          if (remaining > 0) { const kept = chunk.subarray(0, remaining); chunks.push(kept); bytes += kept.length }
        }
        const kill = () => {
          if (!child.pid) return
          if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => { if (error) child.kill() })
          else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
        }
        const stop = (error: Error) => { if (failure) return; failure = error; kill() }
        const abort = () => { clearTimeout(timer); stop(new Error('bash cancelled')) }
        const timer = setTimeout(() => stop(new Error('bash timed out after 30000ms')), 30_000)
        exec.signal.addEventListener('abort', abort, { once: true })
        if (exec.signal.aborted) abort()
        const cleanup = () => { clearTimeout(timer); exec.signal.removeEventListener('abort', abort) }
        child.stdout.on('data', collect)
        child.stderr.on('data', collect)
        child.on('error', error => { cleanup(); reject(error) })
        child.on('close', code => {
          cleanup()
          const output = Buffer.concat(chunks).toString('utf8') + (truncated ? `\n[output collection truncated at ${maxCaptureBytes} bytes]` : '')
          if (failure) reject(failure)
          else if (code !== 0) reject(new Error(`bash exited with code ${code}\n${output}`))
          else resolve(output)
        })
      })
    },
  }), 'register bash')
}
