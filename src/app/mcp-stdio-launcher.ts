import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import spawn from 'cross-spawn'
import { childEnvironment } from '../core/child-environment.js'

// R07 残差：MCP SDK 自己启动 stdio 子进程，只做名称清洗（代理、SSH agent、
// NODE_OPTIONS、真实 HOME 都会传下去）。这里用一个薄启动器把「进程怎么起」拿回本仓库：
// 启动器自己由 SDK 拉起，再用 childEnvironment 构造显式子进程 env 并代理 stdio。
// 它不解析协议，只搬运字节；stdout 上不允许写任何诊断，否则会破坏 JSON-RPC 帧。
const shutdownGraceMs = 1_000
const killGraceMs = 1_000

function fail(message: string): never {
  process.stderr.write(`mini-dsh MCP stdio launcher: ${message}\n`)
  process.exit(64)
}

function parseArguments(argv: string[]) {
  if (argv[0] !== '--env-names' || argv[1] === undefined) fail('expected --env-names <names> -- <command> [args...]')
  const names = argv[1] === '' ? [] : argv[1].split(',')
  if (!names.every(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) fail('invalid explicit environment name')
  const command = argv[3]
  if (argv[2] !== '--' || command === undefined || command === '') fail('expected --env-names <names> -- <command> [args...]')
  return { names, command, args: argv.slice(4) }
}

async function main() {
  const { names, command, args } = parseArguments(process.argv.slice(2))
  const additions: NodeJS.ProcessEnv = {}
  for (const name of names) {
    const value = process.env[name]
    if (value === undefined) fail(`explicit environment variable ${name} is missing`)
    additions[name] = value
  }
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-mcp-'))
  const env = childEnvironment(home, additions, process.env)
  let child: ReturnType<typeof spawn>
  try {
    // cross-spawn 与 MCP SDK 使用同一条 Windows .cmd/shebang 解析路径；env 仍是显式构造的。
    child = spawn(command, args, { cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  } catch (error) {
    await fs.rm(home, { recursive: true, force: true })
    fail(`cannot start ${command}: ${String(error)}`)
  }
  const stdin = child.stdin!
  const stdout = child.stdout!

  let finished = false
  let terminateTimer: NodeJS.Timeout | undefined
  let killTimer: NodeJS.Timeout | undefined
  const finish = async (code: number) => {
    if (finished) return
    finished = true
    clearTimeout(terminateTimer)
    clearTimeout(killTimer)
    process.stdin.unpipe(stdin)
    process.stdin.destroy()
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
    process.exitCode = code
    // stdout 上可能还有最后几帧在缓冲；给它一个短暂窗口自然排空，再作为兜底退出。
    setTimeout(() => process.exit(code), 1_000).unref()
  }

  child.on('error', error => {
    process.stderr.write(`mini-dsh MCP stdio launcher: ${command}: ${String(error)}\n`)
    void finish(127)
  })
  child.on('exit', (code, signal) => {
    void finish(code ?? (signal ? 1 : 0))
  })
  // 忽略下游关闭时的 EPIPE；它发生在 SDK 主动结束传输期间，不应把诊断写到 stdout。
  stdin.on('error', () => {})
  process.stdout.on('error', () => {})
  process.stdin.pipe(stdin)
  stdout.pipe(process.stdout)
  child.stderr?.pipe(process.stderr)

  // SDK 的 close() 先结束 stdin。stdin EOF 就是 MCP 的关停信号：先让 server 自己退出，
  // 超过宽限再收掉子进程，避免 SDK 只杀掉启动器而留下孙进程。
  process.stdin.on('end', () => {
    if (!stdin.destroyed) stdin.end()
    terminateTimer = setTimeout(() => {
      if (!finished && child.exitCode === null) child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (!finished && child.exitCode === null) child.kill('SIGKILL')
      }, killGraceMs)
      killTimer.unref()
    }, shutdownGraceMs)
    terminateTimer.unref()
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { if (!finished) child.kill(signal) })
}

void main().catch(error => {
  process.stderr.write(`mini-dsh MCP stdio launcher: ${String(error)}\n`)
  process.exit(70)
})
