import test from 'node:test'
import assert from 'node:assert/strict'
import { runCommand, commandFailed } from '../src/core/command-runner.js'

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
