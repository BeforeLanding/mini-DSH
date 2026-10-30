import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createDockerCandidateRunner } from '../scripts/swebench/docker-candidate.js'
import { commandInterpreter, validateCommandEnvironment } from '../scripts/swebench/command-environment.js'
import type { CommandOptions, CommandResult } from '../src/core/command-runner.js'

const result = (status: CommandResult['status']): CommandResult => ({
  type: 'command', version: 1, command: 'cat marker', cwd: '/tmp/candidate', status,
  exitCode: status === 'exited' ? 0 : null, signal: null, durationMs: 1,
  timedOut: status === 'timed_out', cancelled: status === 'cancelled',
  stdout: { text: 'marker', bytes: 6, truncated: false }, stderr: { text: '', bytes: 0, truncated: false },
})

test('Docker candidate maps only workspace cwd and never forwards host environment', async () => {
  const root = path.resolve('candidate workspace')
  const seen: CommandOptions[] = []
  const runner = createDockerCandidateRunner(root, 'candidate-1', {
    run: async options => { seen.push(options); return result('exited') },
  })
  const options: CommandOptions = { executable: 'bash', args: ['-lc', 'cat marker'], command: 'cat marker',
    cwd: path.join(root, 'src'), signal: new AbortController().signal, env: { DEEPSEEK_API_KEY: 'secret' } }
  assert.equal((await runner(options)).stdout.text, 'marker')
  assert.deepEqual(seen[0]?.args, ['exec', '--workdir', '/testbed/src', 'candidate-1', 'bash', '-lc', 'cat marker'])
  assert.deepEqual(seen[0]?.env, {})
  await assert.rejects(runner({ ...options, cwd: path.resolve(root, '..') }), /escapes its workspace/)
  assert.equal(seen.length, 1)
})

test('a timed-out docker exec tears down its container and cannot dispatch again', async () => {
  let calls = 0
  let stops = 0
  const runner = createDockerCandidateRunner(path.resolve('candidate'), 'candidate-2', {
    run: async () => { calls++; return result('timed_out') },
    terminate: async () => { stops++ },
  })
  const options: CommandOptions = { executable: 'bash', args: [], command: 'sleep 30',
    cwd: path.resolve('candidate'), signal: new AbortController().signal }
  assert.equal((await runner(options)).timedOut, true)
  await assert.rejects(runner(options), /terminated/)
  assert.equal(calls, 1)
  assert.equal(stops, 1)
  assert.throws(() => createDockerCandidateRunner(path.resolve('candidate'), 'bad/name'), /invalid candidate/)
})

test('testbed candidate activates the shared interpreter without interpolating the action', async () => {
  const root = path.resolve('candidate workspace')
  let dispatched: CommandOptions | undefined
  const runner = createDockerCandidateRunner(root, 'candidate-testbed', {
    commandEnvironment: 'testbed-v1', run: async options => { dispatched = options; return result('exited') },
  })
  const command = `python - <<'PY'\nprint('quotes: " $HOME $(false)')\nPY\nfalse || true`
  await runner({ executable: 'bash', args: [], command, cwd: root, signal: new AbortController().signal, env: { DEEPSEEK_API_KEY: 'secret' } })
  assert.deepEqual(dispatched?.args, ['exec', '--workdir', '/testbed', 'candidate-testbed', ...commandInterpreter('testbed-v1'), command])
  assert.deepEqual(dispatched?.env, {})
  assert.equal(validateCommandEnvironment(undefined), 'legacy')
  assert.throws(() => validateCommandEnvironment('testbed'), /commandEnvironment/)
})
