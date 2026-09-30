import type { Context } from '@deepseek-ai/cordis'
import fs from 'node:fs'
import path from 'node:path'
import { positiveLimit } from '../core/bounded-text.js'
import { runCommand, commandFailed, type CommandResult } from '../core/command-runner.js'
import { TaskVerification, verificationFiles } from '../core/task-verification.js'
import { isRecord } from '../core/event-store.js'
import type { SessionRuntime } from '../core/session-runtime.js'

export const name = 'mini-tool-bash'
export const inject = ['tools', 'sandbox']

export function apply(ctx: Context, config: { executable?: string; workspace?: string; maxCaptureBytes?: number; timeoutMs?: number; maxVerificationFiles?: number; maxVerificationFileBytes?: number } = {}) {
  const maxCaptureBytes = positiveLimit(config.maxCaptureBytes, 8 * 1024 * 1024, 'maxCaptureBytes')
  const timeoutMs = positiveLimit(config.timeoutMs, 30_000, 'timeoutMs', 2_147_483_647)
  const maxVerificationFiles = positiveLimit(config.maxVerificationFiles, 100, 'maxVerificationFiles', 10000)
  const maxVerificationFileBytes = positiveLimit(config.maxVerificationFileBytes, 1024 * 1024, 'maxVerificationFileBytes')
  const gitBash = path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe')
  const executable = config.executable ?? (process.platform === 'win32' && fs.existsSync(gitBash) ? gitBash : 'bash')
  ctx.effect(() => ctx.tools.register({
    name: 'bash', description: 'Run a bounded foreground bash command after approval. Optional cwd must be an existing workspace directory. Returns structured exit/status, duration and separate stdout/stderr; large logs may have refs for read_tool_result. To record a check, explicitly pass verification.files as workspace-relative file paths (include relevant sources, tests and config). Evidence covers only these files and this command; exit zero does not establish task acceptance.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, verification: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: maxVerificationFiles } }, required: ['files'] } }, required: ['command'] },
    output: { render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      isError: value => commandFailed(value as CommandResult) },
    async execute({ command, cwd, verification }, exec) {
      if (typeof command !== 'string' || !command.trim()) throw new Error('command is required')
      let journal: TaskVerification | undefined, paths: string[] | undefined
      if (verification !== undefined) {
        if (!isRecord(verification) || !Array.isArray(verification.files) || !verification.files.length || verification.files.length > maxVerificationFiles || !verification.files.every(file => typeof file === 'string' && !!file && !/[\r\n\0\\]/.test(file) && !path.isAbsolute(file) && !/^[A-Za-z]:/.test(file) && !file.split('/').some(part => part === '..' || part === '.' || !part)) || new Set(verification.files).size !== verification.files.length) throw new Error('verification.files must be unique workspace-relative file paths within the configured limit')
        paths = verification.files as string[]
        const sessions = ctx.get('sessions') as SessionRuntime | undefined
        const state = exec.sessionId && sessions?.latestRun(exec.sessionId)
        if (!exec.sessionId || !sessions || !state || state.status !== 'running') throw new Error('verification requires a session with an active run')
        journal = new TaskVerification(sessions, exec.sessionId, state)
        for (const file of paths) ctx.sandbox.resolvePath(file)
      }
      const resolveCwd = () => {
        const target = ctx.sandbox.resolvePath(cwd ?? '.')
        if (!fs.statSync(target).isDirectory()) throw new Error('cwd must be a directory')
        return fs.realpathSync.native(target)
      }
      const directory = resolveCwd()
      ctx.sandbox.assertCommand(command)
      await ctx.sandbox.approve({ tool: 'bash', summary: `bash (cwd: ${directory}): ${command}${paths ? `\nverification files (workspace-relative): ${paths.join(', ')}` : ''}`, signal: exec.signal, approval: exec.approval })
      ctx.sandbox.assertCommand(command)
      if (resolveCwd() !== directory) throw new Error('cwd changed during approval')
      exec.signal.throwIfAborted()
      const before = paths ? await verificationFiles(paths, file => ctx.sandbox.resolvePath(file), maxVerificationFileBytes, exec.signal) : undefined
      const verificationId = journal && before ? await journal.start({ command, cwd: directory, toolCallId: exec.toolCallId, files: before }) : undefined
      exec.signal.throwIfAborted()
      ctx.sandbox.assertCommand(command)
      if (resolveCwd() !== directory) throw new Error('cwd changed before command execution')
      const result = await runCommand({ executable, args: ['-lc', command], command, cwd: directory, signal: exec.signal, maxCaptureBytes, timeoutMs })
      if (journal && verificationId && paths) {
        // Cancelled collection must not bypass the signal to perform fresh file reads.
        const after = exec.signal.aborted ? paths.map(file => ({ path: file, error: 'cancelled; post-check file version unavailable' })) : await verificationFiles(paths, file => ctx.sandbox.resolvePath(file), maxVerificationFileBytes, exec.signal, true)
        await journal.finish(verificationId, result, after)
      }
      return result
    },
  }), 'register bash')
}
