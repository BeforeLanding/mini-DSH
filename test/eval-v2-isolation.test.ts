import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createIsolationBackend, isolatedCommandArgs } from '../scripts/eval-v2-isolation.js'
import { runFixtureTask, scriptedAdapter } from '../scripts/eval-fixture.js'
import { evalPolicy } from '../scripts/eval-runner.js'

const runtimeRoot = process.env.MINI_DSH_V2_RUNTIME

test('V2 Linux namespace hides host fixtures while preserving candidate Node and Bash access', { skip: !runtimeRoot }, async () => {
  assert.ok(runtimeRoot)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-v2-isolation-'))
  try {
    const workspace = path.join(directory, 'candidate')
    const secret = path.join(directory, 'hidden-answer.txt')
    await fs.mkdir(workspace)
    await fs.writeFile(path.join(workspace, 'smoke.txt'), 'visible')
    await fs.writeFile(secret, 'hidden reference')
    const backend = createIsolationBackend({ workspace, runtimeRoot })
    const capabilities = await backend.preflight()
    assert.equal(capabilities.kind, process.platform === 'win32' ? 'wsl-bwrap' : 'linux-bwrap')
    assert.match(capabilities.runtimeDigest, /^[a-f0-9]{64}$/)
    const secretPath = backend.visibleHostPath(secret)
    const signal = new AbortController().signal
    const run = (command: string) => backend.run({ executable: 'ignored', args: [], command, cwd: workspace, signal, timeoutMs: 10_000 })
    const healthy = await run('node -p process.version && cat smoke.txt')
    assert.equal(healthy.status, 'exited')
    assert.equal(healthy.exitCode, 0, healthy.stderr.text)
    assert.match(healthy.stdout.text, /v22\..*visible/s)
    const bashProbe = await run(`test ! -e '${secretPath}' && echo host-hidden`)
    assert.equal(bashProbe.exitCode, 0, bashProbe.stderr.text)
    assert.match(bashProbe.stdout.text, /host-hidden/)
    const nodeProbe = await run(`node -e "if (require('fs').existsSync('${secretPath}')) process.exit(17)"`)
    assert.equal(nodeProbe.exitCode, 0, nodeProbe.stderr.text)
    const cancellation = new AbortController()
    const pending = backend.run({ executable: 'ignored', args: [], command: 'sleep 2; echo late > late.txt', cwd: workspace, signal: cancellation.signal, timeoutMs: 10_000 })
    setTimeout(() => cancellation.abort(), 100)
    const cancelled = await pending
    assert.equal(cancelled.status, 'cancelled')
    await new Promise(resolve => setTimeout(resolve, 2_200))
    await assert.rejects(fs.stat(path.join(workspace, 'late.txt')), { code: 'ENOENT' })
    if (process.platform === 'win32') await assert.rejects(async () => { isolatedCommandArgs({ workspace, runtimeRoot }, directory, 'pwd') }, /escapes workspace/)
  } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
})

test('V2 fixture routes candidate Bash through the namespace and accepts only the post-exit copy', { skip: !runtimeRoot }, async () => {
  assert.ok(runtimeRoot)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-v2-fixture-'))
  try {
    const outcome = await runFixtureTask('boundary', scriptedAdapter,
      { ...evalPolicy, contextWindowTokens: 1_000_000 }, undefined, undefined, undefined,
      path.join(directory, 'snapshots'), { runtimeRoot })
    assert.equal(outcome.status, 'completed')
    assert.equal(outcome.accepted, true, outcome.acceptance?.output)
    assert.equal(outcome.episode?.stages.length, 1)
    assert.ok((await fs.stat(path.join(directory, 'acceptance-copy', 'src', 'index.mjs'))).isFile())
  } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
})

test('V2 file tool rejects a known hidden path outside the candidate workspace', { skip: !runtimeRoot }, async () => {
  assert.ok(runtimeRoot)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-v2-files-'))
  try {
    let step = 0
    const outcome = await runFixtureTask('boundary', fixture => {
      const secret = path.join(path.dirname(fixture.workspace), 'hidden-answer.txt')
      fsSync.writeFileSync(secret, 'hidden')
      return {
        provider: 'probe', model: 'file', capabilities: { file: { contextWindowTokens: 1_000_000 } },
        chat: async () => step++ === 0
          ? { toolCalls: [{ id: 'probe', name: 'read_file', arguments: { path: secret } }] }
          : { content: 'probe complete' },
      }
    }, { ...evalPolicy, contextWindowTokens: 1_000_000 }, undefined, undefined, undefined,
    path.join(directory, 'snapshots'), { runtimeRoot })
    assert.equal(outcome.status, 'completed')
    assert.equal(outcome.counters.toolErrors, 1)
    assert.equal(outcome.accepted, false)
  } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
})
