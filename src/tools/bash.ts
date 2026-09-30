import type { Context } from '@deepseek-ai/cordis'
import fs from 'node:fs'
import path from 'node:path'
import { positiveLimit } from '../core/bounded-text.js'
import { runCommand, commandFailed, type CommandResult } from '../core/command-runner.js'

export const name = 'mini-tool-bash'
export const inject = ['tools', 'sandbox']

export function apply(ctx: Context, config: { executable?: string; workspace?: string; maxCaptureBytes?: number; timeoutMs?: number } = {}) {
  const maxCaptureBytes = positiveLimit(config.maxCaptureBytes, 8 * 1024 * 1024, 'maxCaptureBytes')
  const timeoutMs = positiveLimit(config.timeoutMs, 30_000, 'timeoutMs', 2_147_483_647)
  const gitBash = path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe')
  const executable = config.executable ?? (process.platform === 'win32' && fs.existsSync(gitBash) ? gitBash : 'bash')
  ctx.effect(() => ctx.tools.register({
    name: 'bash', description: 'Run a bounded foreground bash command after approval. Optional cwd must be an existing workspace directory. Returns structured exit/status, duration and separate stdout/stderr; large logs may have refs for read_tool_result. Exit zero does not establish task verification.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] },
    output: { render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      isError: value => commandFailed(value as CommandResult) },
    async execute({ command, cwd }, exec) {
      if (typeof command !== 'string' || !command.trim()) throw new Error('command is required')
      const resolveCwd = () => {
        const target = ctx.sandbox.resolvePath(cwd ?? '.')
        if (!fs.statSync(target).isDirectory()) throw new Error('cwd must be a directory')
        return fs.realpathSync.native(target)
      }
      const directory = resolveCwd()
      ctx.sandbox.assertCommand(command)
      await ctx.sandbox.approve({ tool: 'bash', summary: `bash (cwd: ${directory}): ${command}`, signal: exec.signal, approval: exec.approval })
      ctx.sandbox.assertCommand(command)
      if (resolveCwd() !== directory) throw new Error('cwd changed during approval')
      exec.signal.throwIfAborted()
      return runCommand({ executable, args: ['-lc', command], command, cwd: directory, signal: exec.signal, maxCaptureBytes, timeoutMs })
    },
  }), 'register bash')
}
