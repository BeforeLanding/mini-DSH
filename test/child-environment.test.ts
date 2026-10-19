import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { childEnvironment } from '../src/core/child-environment.js'
import { runCommand } from '../src/core/command-runner.js'

test('child environment inherits operational variables only and pins an isolated home', () => {
  const home = path.join(os.tmpdir(), 'child-home-fixture')
  const parent = { PATH: 'fixture-path', TMP: os.tmpdir(), DEEPSEEK_API_KEY: 'fake-secret-token',
    HTTPS_PROXY: 'fake-proxy-secret', NODE_OPTIONS: '--require evil', GIT_CONFIG_GLOBAL: 'secret-git-config',
    SSH_AUTH_SOCK: 'secret-socket', AWS_SECRET_ACCESS_KEY: 'secret-cloud-key' }
  const env = childEnvironment(home, {}, parent)
  assert.equal(env.PATH, 'fixture-path')
  assert.equal(env.HOME, home)
  for (const key of ['DEEPSEEK_API_KEY', 'HTTPS_PROXY', 'NODE_OPTIONS', 'GIT_CONFIG_GLOBAL', 'SSH_AUTH_SOCK', 'AWS_SECRET_ACCESS_KEY']) assert.equal(env[key], undefined)
  assert.equal(childEnvironment(home, { EXPLICIT_DATA: 'allowed' }, parent).EXPLICIT_DATA, 'allowed')
  assert.throws(() => childEnvironment(home, { HOME: '/other' }, parent), /cannot be overridden/)
})

test('spawned command does not see parent secrets and receives a disposable home', async () => {
  const previous = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'fake-secret-token'
  try {
    const result = await runCommand({ executable: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({secret:process.env.DEEPSEEK_API_KEY ?? null,home:process.env.HOME,path:!!process.env.PATH}))'],
      command: 'inspect child environment', cwd: process.cwd(), signal: new AbortController().signal })
    assert.equal(result.exitCode, 0)
    const output = JSON.parse(result.stdout.text) as { secret: string | null; home: string; path: boolean }
    assert.equal(output.secret, null)
    assert.equal(output.path, true)
    assert.notEqual(output.home, os.homedir())
    await assert.rejects(fs.access(output.home))
    assert.doesNotMatch(JSON.stringify(result), /fake-secret-token/)
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previous
  }
})
