import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createFixture } from './coding-fixtures.js'
import { heading } from './demo-context.js'
import { CLI_BUDGET } from '../src/core/budget.js'
import { JsonlStore } from '../src/core/event-store.js'
import * as sessions from '../src/plugins/session.js'
import * as systemPrompt from '../src/plugins/system-prompt.js'
import * as tools from '../src/plugins/tools.js'
import * as llm from '../src/plugins/llm.js'
import * as agents from '../src/plugins/agent.js'
import * as agentLoop from '../src/plugins/agent-loop.js'

// NX-10 第三幕：unknown——「工具已经写了、结果没落盘」时恢复成什么样。
//
// 崩溃是真的：子进程执行一条会写下真实副作用文件、然后永久阻塞的命令，父进程等文件出现后按
// 进程树把它杀掉。所以留在磁盘上的残局也是真的——一条只有 tool/start 的调用，和一把没人释放的
// writer.lock。手写一段半拉日志也能让 restore 产出同样的记录，但那样展示的是我们编的东西。
heading('NX-10 第三幕：崩溃恢复——工具已写、结果未落盘')

const exists = (target: string) => fs.access(target).then(() => true, () => false)
async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string, detail: () => string) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`等待「${label}」超时。子进程输出：${detail()}`)
}

const fixture = await createFixture('repair')
const runDirectory = path.resolve('.demo-runs', 'demo-unknown')
await fs.rm(runDirectory, { recursive: true, force: true })
await fs.mkdir(runDirectory, { recursive: true })
const childScript = fileURLToPath(new URL('./demo-unknown-child.js', import.meta.url))

let failed = false
let store: JsonlStore | undefined
let root: Context | undefined
try {
  const child = spawn(process.execPath, [childScript, fixture.workspace, runDirectory, fixture.tasks[0]], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
  })
  let stdout = '', stderr = ''
  child.stdout?.setEncoding('utf8'); child.stdout?.on('data', chunk => { stdout += chunk })
  child.stderr?.setEncoding('utf8'); child.stderr?.on('data', chunk => { stderr += chunk })
  const pid = child.pid
  if (pid === undefined) throw new Error('子进程没有启动')
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))

  await waitFor(async () => /SESSION [0-9a-f-]{36}/.test(stdout), 20_000, '子进程握手', () => JSON.stringify(stderr))
  const sessionId = /SESSION ([0-9a-f-]{36})/.exec(stdout)?.[1]
  if (!sessionId) throw new Error('子进程没有报告会话 id')
  // 父进程等的是**副作用文件**，不是 tool/start：tool/start 在 bash 启动之前就已经落盘了，
  // 只有副作用文件才能证明命令真的在执行中，杀戮因此不会与「命令已跑完」抢时间。
  const sideEffect = path.join(fixture.workspace, '.demo-side-effect')
  await waitFor(() => exists(sideEffect), 20_000, '副作用文件', () => JSON.stringify(stderr))
  if (process.platform === 'win32') await new Promise<void>((resolve, reject) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], error => error ? reject(error) : resolve()))
  else { try { process.kill(-pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
  const exit = await exited

  const sessionDirectory = path.join(runDirectory, sessionId)
  const lockPath = path.join(sessionDirectory, 'writer.lock')
  const eventsPath = path.join(sessionDirectory, 'events.jsonl')
  heading('[1] 崩溃现场')
  console.log(`  子进程 pid=${pid} 被终止（退出码 ${exit.code}，signal ${exit.signal}）`)
  console.log(`  副作用文件 ${path.relative(fixture.workspace, sideEffect)} 内容 ${JSON.stringify(await fs.readFile(sideEffect, 'utf8'))}`)
  const crashLog = await fs.readFile(eventsPath, 'utf8')
  console.log(`  崩溃前的日志 ${crashLog.trim().split('\n').length} 行，最后一条：`)
  console.log(`    ${crashLog.trim().split('\n').at(-1)}`)

  heading('[2] 直接重开：被陈旧锁拒绝')
  let refused: string | undefined
  try { const opened = await JsonlStore.open(runDirectory, sessionId); await opened.close() }
  catch (error) { refused = error instanceof Error ? error.message : String(error) }
  console.log(`  ${refused ?? '（意外：竟然开成功了）'}`)

  heading('[3] 锁是谁的：这一步由操作者判断')
  console.log(`  writer.lock = ${await fs.readFile(lockPath, 'utf8')}`)
  console.log('  它记着持有者的 pid，但 Harness 不替你猜——原话就是 verify stale locks explicitly。')
  console.log('  于是这里做操作者会做的事：确认那个 pid 已经不存在，再显式删掉锁。')
  console.log('  目前没有可脚本化的核验入口，也没有 /recover，这也是 NX-21 立项的原因。')
  await fs.unlink(lockPath)

  try { store = await JsonlStore.open(runDirectory, sessionId) }
  catch (error) {
    // tool/start 是 flush 过的整行，正常走不到这里；真被截断在半行上时先隔离再开。
    try { await JsonlStore.quarantineTail(runDirectory, sessionId) } catch { throw error }
    store = await JsonlStore.open(runDirectory, sessionId)
  }
  const before = await store.read()

  heading('[4] 恢复：restore 给未完成的调用补一个配对结果')
  root = new Context()
  for (const plugin of [sessions, systemPrompt, tools, llm, agents, agentLoop]) await root.plugin(plugin)
  // 注册同一个模型只为让续跑能走到预算校验：续跑会在派发任何请求之前被拒绝。
  root.llm.register('scripted', { models: ['demo'], capabilities: { demo: { contextWindowTokens: 1_000_000 } }, chat: async () => ({ content: '不会被调用' }) })
  const restored = await root.sessions.restore(store, fixture.workspace)
  await root.sessions.flush(restored.id)
  const after = await store.read()
  for (const event of after.slice(before.length)) console.log(`  + ${event.type} ${JSON.stringify(event.data)}`)
  console.log(`  日志行数 ${before.length} → ${after.length}：补出来的记录是**真的追加到磁盘上**的，不是内存里的重演。`)

  const unknowns = after.filter(event => event.type === 'tool/result' && event.data.status === 'unknown')
  const run = root.sessions.latestRun(restored.id)
  const agent = root.agents.create({ name: 'demo-unknown-parent', sessionId: restored.id, model: 'scripted/demo', loop: root.agentLoop, budget: CLI_BUDGET })
  let continuation: string | undefined
  try { await agent.continue() } catch (error) { continuation = error instanceof Error ? error.message : String(error) }

  heading('[5] 判定')
  const checks: [string, boolean][] = [
    ['重开先被陈旧锁拒绝', /session writer lock exists/.test(refused ?? '')],
    ['副作用文件仍在（它真的写过）', await exists(sideEffect)],
    ['恰好一条 unknown 结果，且就是那次 bash', unknowns.length === 1 && unknowns[0]?.type === 'tool/result' && unknowns[0].data.toolCallId === 'wedged'],
    ['被崩溃中断的 run 被封为 error', run?.status === 'error'],
    ['补出的记录落盘（日志行数增加）', after.length > before.length],
    ['自动续跑被拒', /unknown tool outcome/.test(continuation ?? '')],
  ]
  for (const [label, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  console.log(`  续跑被拒的原文：${JSON.stringify(continuation ?? null)}`)
  console.log('  注意 unknown 与 skipped 的分界：这条调用有过 tool/start，所以它的结局无从得知；')
  console.log('  不曾开始的调用会记成 skipped。两者都不会被自动重试——副作用只能由人去核实。')
  console.log(`  事件日志：${path.relative(process.cwd(), eventsPath)}`)
  failed = checks.some(([, ok]) => !ok)
} catch (error) {
  failed = true
  console.error(`第三幕失败：${error instanceof Error ? error.message : String(error)}`)
} finally {
  if (root) { await root.sessions.close().catch(() => {}); await root.fiber.dispose() }
  else await store?.close().catch(() => {})
  await fixture.close()
}
if (failed) process.exitCode = 1
