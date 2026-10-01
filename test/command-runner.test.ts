import test from 'node:test'
import assert from 'node:assert/strict'
import { runCommand, commandFailed } from '../src/core/command-runner.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const run = (code: string, maxCaptureBytes?: number) => runCommand({ executable: process.execPath,
  args: ['-e', code], command: code, cwd: process.cwd(), signal: new AbortController().signal, maxCaptureBytes })

test('command runner separates streams and preserves nonzero exit and spawn failure', async () => {
  const success = await run('process.stdout.write("out");process.stderr.write("err")')
  assert.equal(success.type, 'command'); assert.equal(success.status, 'exited'); assert.equal(success.exitCode, 0)
  assert.equal(success.stdout.text, 'out'); assert.equal(success.stderr.text, 'err')
  assert.equal(success.stdout.bytes, 3); assert.ok(success.durationMs >= 0); assert.equal(commandFailed(success), false)
  const failure = await run('process.stdout.write("partial");process.stderr.write("bad");process.exit(7)')
  assert.equal(failure.exitCode, 7); assert.equal(failure.stdout.text, 'partial'); assert.equal(failure.stderr.text, 'bad')
  assert.equal(commandFailed(failure), true)
  const missing = await runCommand({ executable: 'mini-dsh-missing-executable', args: [], command: 'missing', cwd: process.cwd(), signal: new AbortController().signal })
  assert.equal(missing.status, 'spawn_error'); assert.equal(missing.exitCode, null); assert.ok(missing.error)
})

test('command collection shares a cap, drains streams and avoids a cut Unicode suffix', async () => {
  const result = await run('process.stdout.write("中".repeat(100000));process.stderr.write("err".repeat(100000))', 4)
  assert.equal(result.exitCode, 0); assert.ok(result.stdout.bytes + result.stderr.bytes <= 4)
  assert.ok(result.stdout.truncated || result.stderr.truncated)
  assert.ok(!result.stdout.text.includes('\ufffd')); assert.ok(!result.stderr.text.includes('\ufffd'))
  const empty = await run('')
  assert.deepEqual(empty.stdout, { text: '', bytes: 0, truncated: false })
  await assert.rejects(run('', 0), /positive/)
})

test('foreground timeout retains partial streams and actual termination information', async () => {
  const result = await runCommand({ executable: process.execPath,
    args: ['-e', 'process.stdout.write("started");process.stderr.write("pending");setInterval(()=>{},1000)'],
    command: 'synthetic hung command', cwd: process.cwd(), signal: new AbortController().signal, timeoutMs: 1000 })
  assert.equal(result.status, 'timed_out'); assert.equal(result.timedOut, true); assert.equal(result.cancelled, false)
  assert.equal(result.stdout.text, 'started'); assert.equal(result.stderr.text, 'pending'); assert.equal(commandFailed(result), true)
  if (process.platform !== 'win32') assert.equal(result.signal, 'SIGKILL')
  const terminated = await run('process.kill(process.pid,"SIGTERM")')
  assert.equal(commandFailed(terminated), true)
  if (process.platform !== 'win32') { assert.equal(terminated.exitCode, null); assert.equal(terminated.signal, 'SIGTERM') }
})

test('cancellation returns partial logs and kills descendants before their side effect', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'command-tree-'))
  const controller = new AbortController()
  const ready = path.join(directory, 'ready'), marker = path.join(directory, 'marker')
  const grandchild = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected'),1500);setInterval(()=>{},1000)`
  const code = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});process.stdout.write('partial');require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`
  const pending = runCommand({ executable: process.execPath, args: ['-e', code], command: 'synthetic process tree', cwd: directory, signal: controller.signal, timeoutMs: 5000 })
  try {
    for (let attempt = 0; ; attempt++) {
      try { await fs.access(ready); break } catch { if (attempt > 200) throw new Error('child did not become ready'); await delay(10) }
    }
    controller.abort()
    const result = await pending
    assert.equal(result.status, 'cancelled'); assert.equal(result.cancelled, true); assert.equal(result.timedOut, false)
    assert.equal(result.stdout.text, 'partial'); assert.equal(commandFailed(result), true)
    // 这里刻意**不**加「durationMs 不得短于一次 taskkill 往返」之类的断言：实测新旧实现都约
    // 400～460ms（老的 close 本来就要等 taskkill 把子进程杀掉才触发），两边都过，那样的断言
    // 声称能区分实现却并不区分。真正的不变式由下一行的 marker 断言把住。
    await delay(1700)
    await assert.rejects(fs.access(marker))
    await assert.rejects(runCommand({ executable: process.execPath, args: ['-e', ''], command: '', cwd: directory, signal: AbortSignal.abort() }), /abort/i)
  } finally { controller.abort(); await pending; await fs.rm(directory, { recursive: true, force: true }) }
})
