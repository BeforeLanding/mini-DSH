import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runCommand } from '../src/core/command-runner.js'
import type { CommandOptions, CommandResult } from '../src/core/command-runner.js'

// R08：隔离后端接口。Windows 保留 WSL→bwrap；Linux 直接使用宿主 bwrap 与固定 runtime。
// 平台无关代码只依赖 IsolationBackend；平台专用路径与参数留在各自的 builder 里。
export interface V2IsolationConfig {
  workspace: string
  runtimeRoot: string
  // 仅 WSL 后端需要；Linux 后端忽略。
  distro?: string
  backend?: 'auto' | 'wsl' | 'bwrap'
}

export interface IsolationCapabilities {
  kind: 'wsl-bwrap' | 'linux-bwrap'
  platform: NodeJS.Platform
  runtimeRoot: string
  runtimeDigest: string
  namespace: true
  network: 'isolated'
  hiddenHostPaths: true
  workspaceWritable: true
  treeTermination: true
}

export interface IsolationBackend {
  kind: IsolationCapabilities['kind']
  visibleHostPath(hostPath: string): string
  capabilityManifest(): Promise<IsolationCapabilities>
  preflight(): Promise<IsolationCapabilities>
  run(options: CommandOptions): Promise<CommandResult>
  dispose(): Promise<void>
}

export function windowsToWslPath(target: string): string {
  const resolved = path.win32.resolve(target)
  const match = /^([A-Za-z]):\\(.*)$/.exec(resolved)
  if (!match) throw new Error(`V2 isolation requires a local Windows drive path: ${target}`)
  return `/mnt/${match[1]?.toLowerCase()}/${match[2]?.replaceAll('\\', '/')}`
}

function validateDirectories(config: V2IsolationConfig, cwd: string) {
  const workspace = fs.realpathSync.native(config.workspace)
  const runtime = fs.realpathSync.native(config.runtimeRoot)
  if (!fs.statSync(workspace).isDirectory() || !fs.statSync(runtime).isDirectory()) throw new Error('V2 isolation needs workspace and runtime directories')
  const relative = path.relative(workspace, fs.realpathSync.native(cwd))
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('candidate cwd escapes workspace')
  const runtimeRelation = path.relative(workspace, runtime)
  if (runtimeRelation === '' || (!runtimeRelation.startsWith(`..${path.sep}`) && runtimeRelation !== '..' && !path.isAbsolute(runtimeRelation))) throw new Error('isolation runtime must be outside candidate workspace')
  if (!fs.existsSync(path.join(runtime, 'usr', 'bin', 'node'))) throw new Error('isolation runtime has no Linux Node binary')
  return { workspace, runtime, relative }
}

function isolatedLinuxCommandArgs(config: V2IsolationConfig, cwd: string, command: string) {
  const { workspace, runtime, relative } = validateDirectories(config, cwd)
  const linuxCwd = relative ? `/workspace/${relative.replaceAll('\\', '/')}` : '/workspace'
  const args = [
    '--ro-bind', '/usr/bin', '/usr/bin', '--ro-bind', '/usr/lib', '/usr/lib',
    '--dir', '/usr/share',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
    '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--dir', '/workspace', '--bind', workspace, '/workspace',
    '--ro-bind', runtime, '/runtime', '--chdir', linuxCwd,
    '--ro-bind', path.join(runtime, 'usr', 'share', 'nodejs'), '/usr/share/nodejs',
    '--clearenv', '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/runtime/usr/bin:/usr/bin:/bin',
    '--setenv', 'LD_LIBRARY_PATH', '/runtime/usr/lib/x86_64-linux-gnu',
    '--unshare-all', '--die-with-parent', '--new-session', '/usr/bin/bash', '-lc', command,
  ]
  // 不同 Ubuntu 镜像对 /usr/lib64、/lib64 是否存在并不一致；只在宿主存在时绑定。
  for (const directory of ['/usr/lib64', '/lib64']) if (fs.existsSync(directory)) args.unshift('--ro-bind', directory, directory)
  return args
}

export function isolatedCommandArgs(config: V2IsolationConfig, cwd: string, command: string): string[] {
  if (process.platform !== 'win32') throw new Error('V2 WSL isolation is only available on Windows')
  const distro = config.distro ?? 'Ubuntu'
  if (!/^[A-Za-z0-9_-]+$/.test(distro)) throw new Error('invalid WSL distro')
  const { workspace, runtime, relative } = validateDirectories(config, cwd)
  const linuxCwd = relative ? `/workspace/${relative.replaceAll('\\', '/')}` : '/workspace'
  return [
    '-d', distro, '--', 'bwrap',
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

function runtimeDigest(runtimeRoot: string) {
  const hash = createHash('sha256')
  hash.update(fs.readFileSync(path.join(runtimeRoot, 'usr', 'bin', 'node')))
  const manifest = fileURLToPath(new URL('eval-v2-runtime.sha256', import.meta.url))
  if (fs.existsSync(manifest)) hash.update(fs.readFileSync(manifest))
  return hash.digest('hex')
}

// preflight 验证的是「这个后端在这个 runner 上真的能隔离」，不是只看环境变量：
// 命名空间可用、没有非回环网络接口、工作区可写、工作区外的 sentinel 不可见、超时能收掉后代进程。
async function probe(backend: IsolationBackend) {
  const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-v2-preflight-'))
  const sentinel = path.join(path.dirname(workspace), `${path.basename(workspace)}-hidden.txt`)
  let failure: unknown
  try {
    await fs.promises.writeFile(sentinel, 'host-only', { flag: 'wx' })
    const visibleSentinel = backend.visibleHostPath(sentinel)
    const check = await backend.run({
      executable: 'ignored', args: [], cwd: workspace, signal: new AbortController().signal, timeoutMs: 20_000,
      command: `node -e "const fs=require('fs');const os=require('os');fs.writeFileSync('preflight-writable','ok');if(Object.values(os.networkInterfaces()).flat().some(i=>!i.internal))process.exit(3);console.log(process.version)" && test ! -e '${visibleSentinel}'`,
    })
    if (check.status !== 'exited' || check.exitCode !== 0) throw new Error(`isolation preflight failed: ${check.stderr.text || check.stdout.text}`)
    const timeout = await backend.run({
      executable: 'ignored', args: [], cwd: workspace, signal: new AbortController().signal, timeoutMs: 150,
      command: 'sleep 2; echo escaped > escaped.txt',
    })
    if (timeout.status !== 'timed_out' && timeout.status !== 'cancelled') throw new Error(`isolation timeout probe did not time out: ${timeout.status}`)
    await new Promise(resolve => setTimeout(resolve, 2_300))
    if (fs.existsSync(path.join(workspace, 'escaped.txt'))) throw new Error('isolation timeout left a descendant running')
  } catch (error) { failure = error } finally {
    await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    await fs.promises.rm(sentinel, { force: true })
  }
  if (failure) throw failure
}

class BwrapBackend implements IsolationBackend {
  kind: IsolationCapabilities['kind']
  #config: V2IsolationConfig
  #args: (cwd: string, command: string) => string[]
  constructor(config: V2IsolationConfig, kind: IsolationCapabilities['kind'], args: (cwd: string, command: string) => string[]) {
    this.#config = config
    this.kind = kind
    this.#args = args
  }
  visibleHostPath(hostPath: string) { return this.kind === 'wsl-bwrap' ? windowsToWslPath(hostPath) : hostPath }
  async capabilityManifest(): Promise<IsolationCapabilities> {
    return { kind: this.kind, platform: process.platform, runtimeRoot: path.resolve(this.#config.runtimeRoot), runtimeDigest: runtimeDigest(this.#config.runtimeRoot),
      namespace: true, network: 'isolated', hiddenHostPaths: true, workspaceWritable: true, treeTermination: true }
  }
  async preflight() { const manifest = await this.capabilityManifest(); await probe(this); return manifest }
  run(options: CommandOptions) {
    return runCommand({ ...options, executable: this.kind === 'wsl-bwrap' ? 'wsl.exe' : 'bwrap', args: this.#args(options.cwd, options.command) })
  }
  async dispose() { /* 每次调用都是一次性的 bwrap；没有常驻连接。 */ }
}

export function createIsolationBackend(config: V2IsolationConfig): IsolationBackend {
  const requested = config.backend ?? 'auto'
  // 构造不触碰运行时：合成测试会传入从未真正执行的 commandRunner。缺 binary 在首次
  // args 构建或 preflight 时失败，不能因为构造就拒绝一个根本不会调用命令的装配。
  if (requested === 'wsl' || (requested === 'auto' && process.platform === 'win32')) {
    if (process.platform !== 'win32') throw new Error('WSL isolation backend requires Windows')
    return new BwrapBackend(config, 'wsl-bwrap', (cwd, command) => isolatedCommandArgs(config, cwd, command))
  }
  if (requested === 'bwrap' || (requested === 'auto' && process.platform === 'linux')) {
    if (process.platform !== 'linux') throw new Error('native bwrap isolation requires Linux')
    return new BwrapBackend(config, 'linux-bwrap', (cwd, command) => isolatedLinuxCommandArgs(config, cwd, command))
  }
  throw new Error(`no V2 isolation backend for platform ${process.platform}`)
}

export function createIsolatedCommandRunner(config: V2IsolationConfig): (options: CommandOptions) => Promise<CommandResult> {
  const backend = createIsolationBackend(config)
  return options => backend.run(options)
}
