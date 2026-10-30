import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { commandInterpreter } from '../scripts/swebench/command-environment.js'
import { externalOverrideConfig } from '../scripts/swebench/external.js'

test('activation failures never dispatch actions; activated actions preserve quotes and exit status', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-activation-'))
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
  try {
    const profile = path.join(directory, 'conda.sh')
    const profilePath = profile.replaceAll('\\', '/')
    await fs.writeFile(profile, 'conda() { export MINI_DSH_TEST_ENV=testbed; }\n')
    const [executable, ...args] = commandInterpreter('testbed-v1')
    assert.equal(executable, 'bash')
    const invoke = (command: string) => spawnSync(bash, [...args.map(value => value.replace('/opt/miniconda3/etc/profile.d/conda.sh', `"${profilePath}"`)), command], { encoding: 'utf8' })
    const ok = invoke(`printf '%s\\n' "$MINI_DSH_TEST_ENV" 'literal $HOME $(false) "quotes"'; exit 7`)
    assert.equal(ok.status, 7, ok.stderr)
    assert.equal(ok.stdout.replaceAll('\r\n', '\n'), 'testbed\nliteral $HOME $(false) "quotes"\n')
    await fs.writeFile(profile, 'conda() { return 17; }\n')
    const failed = invoke('echo SHOULD_NOT_EXECUTE')
    assert.equal(failed.status, 17)
    assert.equal(failed.stdout, '')
    await fs.unlink(profile)
    const missing = invoke('echo SHOULD_NOT_EXECUTE')
    assert.notEqual(missing.status, 0)
    assert.equal(missing.stdout, '')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('external baseline uses the identical opt-in shell and keeps legacy configuration unchanged', () => {
  const input = { model: 'scripted/test', caps: { maxCostUsd: 1, maxModelRequests: 8, maxToolCalls: 16, wallClockMs: 60_000, maxOutputTokens: 1024, maxTotalTokens: 100_000 },
    paths: { episodeDirectory: '/tmp/e', workspace: '/tmp/w', datasetDirectory: '/tmp/d', configPath: '/tmp/c', outputDirectory: '/tmp/o', upstreamConfigPath: '/tmp/u' },
    uid: 1000, gid: 1000, labels: { batch: 'b', episode: 'e' } }
  for (const environment of ['legacy', 'testbed-v1'] as const) {
    const config = externalOverrideConfig({ ...input, commandEnvironment: environment })
    assert.deepEqual((config.environment as Record<string, unknown>).interpreter, commandInterpreter(environment))
    assert.deepEqual((config.environment as Record<string, unknown>).forward_env, [])
  }
})
