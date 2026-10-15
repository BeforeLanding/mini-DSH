import fs from 'node:fs'
import path from 'node:path'
import { runCommand } from '../src/core/command-runner.js'
import type { CommandOptions, CommandResult } from '../src/core/command-runner.js'

export interface V2IsolationConfig { workspace: string; runtimeRoot: string; distro: string }

export function windowsToWslPath(target: string): string {
  const resolved = path.win32.resolve(target)
  const match = /^([A-Za-z]):\\(.*)$/.exec(resolved)
  if (!match) throw new Error(`V2 isolation requires a local Windows drive path: ${target}`)
  return `/mnt/${match[1]?.toLowerCase()}/${match[2]?.replaceAll('\\', '/')}`
}

export function isolatedCommandArgs(config: V2IsolationConfig, cwd: string, command: string): string[] {
  if (process.platform !== 'win32') throw new Error('V2 WSL isolation is only available on Windows')
  if (!/^[A-Za-z0-9_-]+$/.test(config.distro)) throw new Error('invalid WSL distro')
  const workspace = fs.realpathSync.native(config.workspace)
  const runtime = fs.realpathSync.native(config.runtimeRoot)
  if (!fs.statSync(workspace).isDirectory() || !fs.statSync(runtime).isDirectory()) throw new Error('V2 isolation needs workspace and runtime directories')
  const relative = path.relative(workspace, fs.realpathSync.native(cwd))
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('candidate cwd escapes workspace')
  const runtimeRelation = path.relative(workspace, runtime)
  if (runtimeRelation === '' || (!runtimeRelation.startsWith(`..${path.sep}`) && runtimeRelation !== '..' && !path.isAbsolute(runtimeRelation))) throw new Error('isolation runtime must be outside candidate workspace')
  if (!fs.existsSync(path.join(runtime, 'usr', 'bin', 'node'))) throw new Error('isolation runtime has no Linux Node binary')
  const linuxCwd = relative ? `/workspace/${relative.replaceAll('\\', '/')}` : '/workspace'
  return [
    '-d', config.distro, '--', 'bwrap',
    '--dir', '/usr', '--ro-bind', '/usr/bin', '/usr/bin', '--ro-bind', '/usr/lib', '/usr/lib',
    '--ro-bind', '/usr/lib64', '/usr/lib64', '--dir', '/usr/share',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--dir', '/workspace', '--bind', windowsToWslPath(workspace), '/workspace',
    '--ro-bind', windowsToWslPath(runtime), '/runtime', '--chdir', linuxCwd,
    '--ro-bind', windowsToWslPath(path.join(runtime, 'usr', 'share', 'nodejs')), '/usr/share/nodejs',
    '--clearenv', '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/runtime/usr/bin:/usr/bin:/bin',
    '--setenv', 'LD_LIBRARY_PATH', '/runtime/usr/lib/x86_64-linux-gnu',
    '--unshare-all', '--die-with-parent', '--new-session', '/usr/bin/bash', '-lc', command,
  ]
}

export function createIsolatedCommandRunner(config: V2IsolationConfig): (options: CommandOptions) => Promise<CommandResult> {
  return options => runCommand({ ...options, executable: 'wsl.exe', args: isolatedCommandArgs(config, options.cwd, options.command) })
}
