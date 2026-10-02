import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { JsonlStore } from '../src/core/event-store.js'
import { SessionRuntime } from '../src/core/session-runtime.js'

// NX-21：崩溃之后那把 writer.lock 的处置此前只能由人手删文件。这些用例钉住新入口的两半——
// inspectLock 只把证据摆出来（且**不产生副作用**），removeStaleLock 只在操作者把检视里看到的那个
// token 原样递回来时才动手。**守护进程存活判定本身不在这里**：pid 探针只作线索，用例只断言三态各
// 自的取值，不断言「alive 就等于还能安全地留着锁」——那是人的判断。
async function residue(root: string) {
  const sessions = new SessionRuntime(), session = sessions.create({ workspace: root })
  const store = await JsonlStore.open(root, session.id)
  sessions.attachStore(session.id, store)
  const run = sessions.beginRun(session.id, {}, 'mock/demo')
  sessions.append(session.id, 'user/message', { content: 'mock task' }, run)
  sessions.append(session.id, 'assistant/tool_calls', { toolCalls: [{ id: 'wedged', name: 'bash', arguments: {} }] }, run)
  sessions.append(session.id, 'tool/start', { taskId: run.taskId, runId: run.runId, toolCallId: 'wedged', name: 'bash' }, run)
  await sessions.flush(session.id)
  await store.close()
  return session.id
}
// 已退出的子进程 pid 在本机与 CI 上都确定性地不存在，比猜一个大数字可靠（大 pid 还可能撞上 pid 复用）。
async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const pid = child.pid
  await new Promise(resolve => child.on('exit', resolve))
  if (pid === undefined) throw new Error('子进程没有启动')
  return pid
}
const temp = async (label: string) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `mini-dsh-${label}-`))
  return { root, cleanup: async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }) } }
}

test('inspectLock reads the lock without touching the filesystem', async () => {
  const { root, cleanup } = await temp('lock-inspect')
  const sessionId = '11111111-2222-3333-4444-555555555555'
  try {
    await assert.rejects(JsonlStore.inspectLock(root, 'not-a-session-id'), /invalid session id/)
    const missing = await JsonlStore.inspectLock(root, sessionId)
    assert.deepEqual(missing, { present: false, ownerReadable: false, pidStatus: 'inconclusive', eventsTail: 'missing' })
    // 核验不能有副作用：open 会 mkdir，inspectLock 不可以，否则「看一眼」就凭空造出一个会话目录。
    await assert.rejects(fs.access(path.join(root, sessionId)))
  } finally { await cleanup() }
})

test('inspectLock reports the owner and a three-valued pid probe', async () => {
  const { root, cleanup } = await temp('lock-owner')
  const sessionId = '11111111-2222-3333-4444-555555555555'
  const lock = path.join(root, sessionId, 'writer.lock')
  await fs.mkdir(path.dirname(lock), { recursive: true })
  try {
    await fs.writeFile(lock, JSON.stringify({ token: 'stale-token', pid: await deadPid() }))
    const dead = await JsonlStore.inspectLock(root, sessionId)
    assert.equal(dead.present, true)
    assert.equal(dead.ownerReadable, true)
    assert.equal(dead.token, 'stale-token')
    assert.equal(dead.pidStatus, 'not-found')
    assert.equal(dead.modifiedAt, (await fs.stat(lock)).mtime.toISOString())

    await fs.writeFile(lock, JSON.stringify({ token: 'mine', pid: process.pid }))
    assert.equal((await JsonlStore.inspectLock(root, sessionId)).pidStatus, 'alive')
    // pid ≤ 0 一律 inconclusive：win32 上 process.kill(0, 0) 会成功，直接问会拿到一个假的 alive。
    await fs.writeFile(lock, JSON.stringify({ token: 'mine', pid: 0 }))
    assert.equal((await JsonlStore.inspectLock(root, sessionId)).pidStatus, 'inconclusive')

    await fs.writeFile(lock, 'not json')
    const unreadable = await JsonlStore.inspectLock(root, sessionId)
    assert.equal(unreadable.present, true)
    assert.equal(unreadable.ownerReadable, false)
    assert.equal(unreadable.pidStatus, 'inconclusive')
    // 合法 JSON 但形状不对（缺 pid）同样不算可读，否则调用方会拿到半个持有者。
    await fs.writeFile(lock, JSON.stringify({ token: 'mine' }))
    assert.equal((await JsonlStore.inspectLock(root, sessionId)).ownerReadable, false)
  } finally { await cleanup() }
})

test('inspectLock reports whether the event log tail is complete', async () => {
  const { root, cleanup } = await temp('lock-tail')
  const sessionId = '11111111-2222-3333-4444-555555555555'
  const events = path.join(root, sessionId, 'events.jsonl')
  await fs.mkdir(path.dirname(events), { recursive: true })
  try {
    await fs.writeFile(events, '{"a":1}\n')
    assert.equal((await JsonlStore.inspectLock(root, sessionId)).eventsTail, 'complete')
    // 半条记录的形状与 decodeLog 的判据一致：末字节不是换行。
    await fs.appendFile(events, '{"b":')
    assert.equal((await JsonlStore.inspectLock(root, sessionId)).eventsTail, 'incomplete')
  } finally { await cleanup() }
})

test('removeStaleLock refuses a token the operator did not just read', async () => {
  const { root, cleanup } = await temp('lock-token')
  const sessionId = '11111111-2222-3333-4444-555555555555'
  const lock = path.join(root, sessionId, 'writer.lock')
  await fs.mkdir(path.dirname(lock), { recursive: true })
  try {
    await fs.writeFile(lock, JSON.stringify({ token: 'current-owner', pid: process.pid }))
    // 检视与移除之间若有新写入者拿到锁，这里必须拒绝——否则删掉的是一把**活锁**。
    await assert.rejects(JsonlStore.removeStaleLock(root, sessionId, 'stale-token'), /writer lock ownership changed/)
    assert.equal(await fs.readFile(lock, 'utf8'), JSON.stringify({ token: 'current-owner', pid: process.pid }))
    await fs.writeFile(lock, 'not json')
    await assert.rejects(JsonlStore.removeStaleLock(root, sessionId, 'current-owner'), /writer lock ownership changed/)
    await fs.writeFile(lock, JSON.stringify({ token: 'current-owner', pid: process.pid }))
    await JsonlStore.removeStaleLock(root, sessionId, 'current-owner')
    await assert.rejects(fs.access(lock))
    await assert.rejects(JsonlStore.removeStaleLock(root, sessionId, 'current-owner'), /writer lock is gone/)
  } finally { await cleanup() }
})

test('an explicitly removed stale lock reopens and restore marks the interrupted tool unknown', async () => {
  const { root, cleanup } = await temp('lock-restore')
  try {
    const sessionId = await residue(root)
    await fs.writeFile(path.join(root, sessionId, 'writer.lock'), JSON.stringify({ token: 'stale-token', pid: await deadPid() }))
    // 入口只报证据，不替人开锁：检视成功，而 open 仍然拒绝。
    assert.equal((await JsonlStore.inspectLock(root, sessionId)).pidStatus, 'not-found')
    await assert.rejects(JsonlStore.open(root, sessionId), /session writer lock exists/)
    await assert.rejects(JsonlStore.quarantineTail(root, sessionId), /EEXIST/)

    await JsonlStore.removeStaleLock(root, sessionId, 'stale-token')
    const reopened = await JsonlStore.open(root, sessionId), restored = new SessionRuntime()
    const before = await reopened.read()
    await restored.restore(reopened, root)
    await restored.flush(sessionId)
    const after = await reopened.read()
    assert.equal(restored.latestRun(sessionId)?.status, 'error')
    // 恰好一条配对结果，且是 unknown 而不是 skipped：这条调用有过 tool/start。
    assert.deepEqual(after.filter(event => event.type === 'tool/result').map(event => event.type === 'tool/result' ? [event.data.toolCallId, event.data.status] : []), [['wedged', 'unknown']])
    assert.ok(after.length > before.length)
    await reopened.close()
  } finally { await cleanup() }
})

test('the session:lock script inspects, refuses a bad token and removes on an explicit one', async () => {
  const { root, cleanup } = await temp('lock-cli')
  const sessionId = '11111111-2222-3333-4444-555555555555'
  const script = fileURLToPath(new URL('../scripts/session-lock.js', import.meta.url))
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, MINI_DSH_SESSION_DIR: root } })
  const lock = path.join(root, sessionId, 'writer.lock')
  await fs.mkdir(path.dirname(lock), { recursive: true })
  try {
    // 用法错一律非零退出，且不碰磁盘。
    for (const args of [[], [sessionId, '--remove'], [sessionId, '--token', 't'], [sessionId, '--bogus']]) {
      const failure = run(...args)
      assert.equal(failure.status, 1, `参数 ${JSON.stringify(args)} 应当退出 1`)
      assert.match(failure.stderr, /用法：pnpm session:lock/)
    }
    const stale = JSON.stringify({ token: 'stale-token', pid: await deadPid() })
    await fs.writeFile(lock, stale)
    const inspected = run(sessionId)
    assert.equal(inspected.status, 0)
    assert.match(inspected.stdout, /pid 探针：not-found/)
    assert.ok(inspected.stdout.includes(`--remove --token stale-token`), '下一步命令要能直接复制')
    const refused = run(sessionId, '--remove', '--token', 'wrong')
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /writer lock ownership changed/)
    assert.equal(await fs.readFile(lock, 'utf8'), stale)
    assert.equal(run(sessionId, '--remove', '--token', 'stale-token').status, 0)
    await assert.rejects(fs.access(lock))
  } finally { await cleanup() }
})
