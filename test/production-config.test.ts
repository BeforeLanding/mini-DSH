import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { productionHarnessConfig } from '../src/app/production-config.js'
import { createHarness } from '../src/app/create-harness.js'
import { JsonlStore } from '../src/core/event-store.js'

test('production defaults and explicit context/preview choices use the shared harness', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-production-config-'))
  try {
    const defaults = productionHarnessConfig({}, workspace)
    assert.equal(defaults.profile, 'coding')
    assert.equal(defaults.contextLayout, 'live')
    assert.equal(defaults.runtimeClockMode, 'frozen')
    assert.equal(defaults.toolOutputMaxPreviewBytes, undefined)
    const live = await createHarness(defaults)
    try {
      assert.equal(live.capabilityManifest.policy.contextLayout, 'live')
      assert.equal(live.capabilityManifest.policy.runtimeClockMode, 'frozen')
      assert.equal(live.capabilityManifest.policy.toolOutputMaxPreviewBytes, null)
      assert.ok(live.capabilityManifest.tools.includes('read_history'))
    } finally { await live.dispose() }

    const chosen = productionHarnessConfig({ MINI_DSH_CONTEXT_LAYOUT: 'frozen', MINI_DSH_TOOL_PREVIEW_BYTES: '32768' }, workspace)
    assert.equal(chosen.runtimeClockMode, 'frozen')
    const frozen = await createHarness(chosen)
    try {
      assert.equal(frozen.capabilityManifest.policy.contextLayout, 'frozen')
      assert.equal(frozen.capabilityManifest.policy.toolOutputMaxPreviewBytes, 32768)
      assert.ok(frozen.capabilityManifest.tools.includes('read_history'))
    } finally { await frozen.dispose() }
  } finally { await fs.rm(workspace, { recursive: true, force: true }) }
})

test('invalid production layout and preview values fail before assembly', () => {
  for (const layout of ['', 'FULL', 'cached']) assert.throws(() => productionHarnessConfig({ MINI_DSH_CONTEXT_LAYOUT: layout }), /MINI_DSH_CONTEXT_LAYOUT/)
  for (const mode of ['', 'FULL', 'cached']) assert.throws(() => productionHarnessConfig({ MINI_DSH_RUNTIME_TIME_MODE: mode }), /MINI_DSH_RUNTIME_TIME_MODE/)
  for (const preview of ['', '0', '-1', '1.5', 'Infinity', '9007199254740992']) assert.throws(() => productionHarnessConfig({ MINI_DSH_TOOL_PREVIEW_BYTES: preview }), /MINI_DSH_TOOL_PREVIEW_BYTES/)
})

test('frozen snapshots follow session and reset epochs; project_context still reads current disk', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-frozen-lifecycle-'))
  const rules = path.join(workspace, 'AGENTS.md')
  await fs.writeFile(rules, 'first-rule', 'utf8')
  let clock = 0
  const make = () => createHarness({ ...productionHarnessConfig({ MINI_DSH_CONTEXT_LAYOUT: 'frozen' }, workspace), runtimeTime: () => `clock-${++clock}` })
  try {
    const first = await make()
    try {
      const a = first.root.sessions.create({ workspace })
      const initial = await first.root.systemPrompt.assemble({ sessionId: a.id })
      assert.match(initial, /first-rule/)
      assert.match(initial, /clock-1/)
      await fs.writeFile(rules, 'second-rule', 'utf8')
      const anotherSession = first.root.sessions.create()
      assert.ok(anotherSession.id)
      const stale = await first.root.systemPrompt.assemble({ sessionId: a.id })
      assert.match(stale, /first-rule/)
      assert.doesNotMatch(stale, /second-rule/)
      assert.match(stale, /Context version changed/)
      const run = first.root.sessions.beginRun(anotherSession.id, {}, 'offline-model')
      const second = await first.root.systemPrompt.assemble({ sessionId: anotherSession.id })
      assert.deepEqual(first.root.sessions.visibleEvents(anotherSession.id).filter(e => e.type === 'context/snapshot').map(e => e.data.source), ['new-session', 'new-session'])
      first.root.sessions.finishRun(run, 'completed')
      assert.match(second, /second-rule/)
      assert.match(second, /clock-2/)
      assert.match(await first.root.systemPrompt.assemble({ sessionId: a.id }), /Context version changed/, 'switching back retains the saved rules and the change notice')
      const current = await first.root.tools.get('project_context')!.execute({}, { signal: new AbortController().signal })
      assert.match(JSON.stringify(current), /second-rule/)
      assert.doesNotMatch(JSON.stringify(current), /first-rule/)
      first.root.sessions.clear(a.id)
      const afterReset = await first.root.systemPrompt.assemble({ sessionId: a.id })
      assert.match(afterReset, /second-rule/)
      assert.match(afterReset, /clock-3/)
    } finally { await first.dispose() }
    const restarted = await make()
    try {
      const s = restarted.root.sessions.create()
      const refreshed = await restarted.root.systemPrompt.assemble({ sessionId: s.id })
      assert.match(refreshed, /second-rule/)
      assert.match(refreshed, /clock-4/)
    } finally { await restarted.dispose() }
  } finally { await fs.rm(workspace, { recursive: true, force: true }) }
})

test('frozen session snapshot survives JSONL restore; legacy sessions explicitly rebase missing snapshots', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-frozen-restore-'))
  const rules = path.join(workspace, 'AGENTS.md')
  const directory = path.join(workspace, 'sessions')
  let clock = 0
  const make = () => createHarness({ ...productionHarnessConfig({ MINI_DSH_CONTEXT_LAYOUT: 'frozen' }, workspace), runtimeTime: () => `clock-${++clock}` })
  try {
    await fs.writeFile(rules, 'original-rule')
    const first = await make()
    const saved = first.root.sessions.create({ workspace })
    const store = await JsonlStore.open(directory, saved.id)
    first.root.sessions.attachStore(saved.id, store)
    const original = await first.root.systemPrompt.assemble({ sessionId: saved.id })
    assert.equal(first.root.sessions.visibleEvents(saved.id).filter(e => e.type === 'context/snapshot').length, 2)
    await first.root.sessions.close(); await first.dispose()
    await fs.writeFile(rules, 'changed-rule')
    const second = await make()
    const reopened = await JsonlStore.open(directory, saved.id)
    await second.root.sessions.restore(reopened, workspace)
    const restored = await second.root.systemPrompt.assemble({ sessionId: saved.id })
    assert.ok(restored.startsWith(original), 'the saved prompt remains intact before the version notice')
    assert.match(restored, /original-rule/)
    assert.doesNotMatch(restored, /changed-rule/)
    assert.match(restored, /Context version changed/)
    assert.equal(clock, 1, 'restore does not read the clock again')
    const current = await second.root.tools.get('project_context')!.execute({}, { signal: new AbortController().signal })
    assert.match(JSON.stringify(current), /changed-rule/)
    await second.root.sessions.close(); await second.dispose()

    const third = await make()
    const legacy = third.root.sessions.create({ workspace })
    const oldStore = await JsonlStore.open(directory, legacy.id)
    third.root.sessions.attachStore(legacy.id, oldStore)
    const oldRun = third.root.sessions.beginRun(legacy.id, {}, 'offline-model')
    third.root.sessions.append(legacy.id, 'model/start', { taskId: oldRun.taskId, runId: oldRun.runId, requestId: 'old-request' }, oldRun)
    third.root.sessions.append(legacy.id, 'model/usage', { taskId: oldRun.taskId, runId: oldRun.runId, requestId: 'old-request', usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1, source: 'estimated', uncertain: true } }, oldRun)
    third.root.sessions.append(legacy.id, 'model/end', { requestId: 'old-request', complete: true }, oldRun)
    third.root.sessions.finishRun(oldRun, 'completed')
    await third.root.sessions.close(); await third.dispose()
    const fourth = await make()
    const restoredStore = await JsonlStore.open(directory, legacy.id)
    await fourth.root.sessions.restore(restoredStore, workspace)
    const recaptured = await fourth.root.systemPrompt.assemble({ sessionId: legacy.id })
    assert.match(recaptured, /changed-rule/)
    assert.match(recaptured, /clock-2/)
    assert.deepEqual(fourth.root.sessions.visibleEvents(legacy.id).filter(e => e.type === 'context/snapshot').map(e => e.data.source), ['legacy-current', 'legacy-current'])
    await fourth.root.sessions.close(); await fourth.dispose()
  } finally { await fs.rm(workspace, { recursive: true, force: true }) }
})

test('explicit legacy live layout follows disk and clock across turns', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-live-lifecycle-'))
  try {
    const rules = path.join(workspace, 'AGENTS.md')
    await fs.writeFile(rules, 'before-rule')
    let clock = 0
    const harness = await createHarness({ ...productionHarnessConfig({ MINI_DSH_CONTEXT_LAYOUT: 'live' }, workspace), runtimeTime: () => `tick-${++clock}` })
    try {
      const session = harness.root.sessions.create()
      const before = await harness.root.systemPrompt.assemble({ sessionId: session.id })
      await fs.writeFile(rules, 'after-rule')
      const after = await harness.root.systemPrompt.assemble({ sessionId: session.id })
      assert.match(before, /before-rule.*|tick-1/s)
      assert.match(after, /after-rule/)
      assert.match(after, /tick-2/)
      assert.equal(harness.root.sessions.visibleEvents(session.id).filter(e => e.type === 'context/snapshot').length, 0)
    } finally { await harness.dispose() }
  } finally { await fs.rm(workspace, { recursive: true, force: true }) }
})

test('production default freezes the session clock while project rules stay live', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-clock-default-'))
  try {
    const rules = path.join(workspace, 'AGENTS.md')
    await fs.writeFile(rules, 'initial-rule')
    let clock = 0
    const harness = await createHarness({ ...productionHarnessConfig({}, workspace), runtimeTime: () => `tick-${++clock}` })
    try {
      const session = harness.root.sessions.create({ workspace })
      const before = await harness.root.systemPrompt.assemble({ sessionId: session.id })
      await fs.writeFile(rules, 'updated-rule')
      const after = await harness.root.systemPrompt.assemble({ sessionId: session.id })
      assert.match(before, /tick-1/)
      assert.match(after, /tick-1/)
      assert.match(after, /updated-rule/)
      assert.match(after, /Context version changed/)
      assert.equal(clock, 1)
      assert.deepEqual(harness.root.sessions.visibleEvents(session.id).filter(e => e.type === 'context/snapshot').map(e => e.data.name), ['runtime:environment'])
      assert.deepEqual(harness.root.sessions.visibleEvents(session.id).filter(e => e.type === 'context/project-version').map(e => e.data.previousDigest === undefined), [true, false])
      assert.equal(harness.root.sessions.visibleEvents(session.id).filter(e => e.type === 'user/message').length, 0)
    } finally { await harness.dispose() }
    assert.equal(productionHarnessConfig({ MINI_DSH_CONTEXT_LAYOUT: 'frozen', MINI_DSH_RUNTIME_TIME_MODE: 'live' }, workspace).runtimeClockMode, 'live')
  } finally { await fs.rm(workspace, { recursive: true, force: true }) }
})

test('show-config needs no key, reports effective values and sources, and reveals no unrelated environment data', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-show-config-'))
  const entry = fileURLToPath(new URL('../src/index.js', import.meta.url))
  const base: NodeJS.ProcessEnv = { ...process.env, DEEPSEEK_API_KEY: '', MINI_DSH_WORKSPACE: workspace, MINI_DSH_CONTEXT_LAYOUT: 'frozen',
    MINI_DSH_TOOL_PREVIEW_BYTES: '32768', MINI_DSH_BUDGET: '{"maxModelRequests":8}', MINI_DSH_MODEL: 'deepseek/deepseek-v4-flash', PRIVATE_CANARY: 'must-not-appear' }
  delete base.MINI_DSH_SESSION_ID
  try {
    const result = spawnSync(process.execPath, [entry, '--show-config'], { cwd: workspace, env: base, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const shown = JSON.parse(result.stdout)
    assert.deepEqual(shown.contextLayout, { value: 'frozen', source: 'environment' })
    assert.deepEqual(shown.runtimeClockMode, { value: 'frozen', source: 'environment' })
    assert.deepEqual(shown.toolResultPreviewBytes, { value: 32768, source: 'environment' })
    assert.equal(shown.budget.effective.maxModelRequests, 8)
    assert.equal(shown.budget.sources.maxModelRequests, 'environment')
    assert.equal(shown.budget.effective.contextWindowTokens, 1_000_000)
    assert.equal(shown.budget.sources.contextWindowTokens, 'provider capability')
    assert.equal(shown.readHistory.enabled, true)
    assert.ok(shown.tools.includes('project_context'))
    assert.doesNotMatch(result.stdout, /PRIVATE_CANARY|must-not-appear|DEEPSEEK_API_KEY|AGENTS\.md/)
    await fs.writeFile(path.join(workspace, '.env'), 'MINI_DSH_CONTEXT_LAYOUT=frozen\n', 'utf8')
    const fromDotenv = { ...base }
    delete fromDotenv.MINI_DSH_CONTEXT_LAYOUT
    delete fromDotenv.MINI_DSH_TOOL_PREVIEW_BYTES
    const dotenvView = spawnSync(process.execPath, [entry, '--show-config'], { cwd: workspace, env: fromDotenv, encoding: 'utf8' })
    assert.equal(dotenvView.status, 0, dotenvView.stderr)
    const dotenvShown = JSON.parse(dotenvView.stdout)
    assert.deepEqual(dotenvShown.contextLayout, { value: 'frozen', source: '.env' })
    assert.deepEqual(dotenvShown.runtimeClockMode, { value: 'frozen', source: '.env' })
    assert.deepEqual(dotenvShown.toolResultPreviewBytes, { value: 16_384, source: 'default' })
    for (const [key, value] of [['MINI_DSH_CONTEXT_LAYOUT', 'invalid'], ['MINI_DSH_TOOL_PREVIEW_BYTES', '0'],
      ['MINI_DSH_BUDGET', '{"bad":1}']] as const) {
      const invalid = spawnSync(process.execPath, [entry, '--show-config'], { cwd: workspace, env: { ...base, [key]: value }, encoding: 'utf8' })
      assert.notEqual(invalid.status, 0, key)
      assert.equal(invalid.stdout, '')
      assert.match(invalid.stderr, new RegExp(key === 'MINI_DSH_BUDGET' ? 'unknown budget key' : key))
    }
    const resumed = spawnSync(process.execPath, [entry, '--show-config'], { cwd: workspace, env: { ...base, MINI_DSH_SESSION_ID: 'existing' }, encoding: 'utf8' })
    assert.notEqual(resumed.status, 0)
    assert.match(resumed.stderr, /new-session configuration/)
  } finally { await fs.rm(workspace, { recursive: true, force: true }) }
})

test('CLI metadata commands ignore workspace config, and interactive startup explains a missing key', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini dsh installed entry '))
  const entry = fileURLToPath(new URL('../src/index.js', import.meta.url))
  const packageMetadata = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
  const sessionDirectory = path.join(workspace, 'sessions')
  const env: NodeJS.ProcessEnv = { ...process.env, DEEPSEEK_API_KEY: '', MINI_DSH_SESSION_DIR: sessionDirectory }
  for (const key of ['MINI_DSH_SESSION_ID', 'MINI_DSH_WORKSPACE', 'MINI_DSH_PROFILE', 'MINI_DSH_CONTEXT_LAYOUT']) delete env[key]
  try {
    await fs.writeFile(path.join(workspace, '.env'), 'MINI_DSH_PROFILE=invalid\n')
    const help = spawnSync(process.execPath, [entry, '--help'], { cwd: workspace, env, encoding: 'utf8' })
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /Usage: mini-dsh/)
    const version = spawnSync(process.execPath, [entry, '--version'], { cwd: workspace, env, encoding: 'utf8' })
    assert.equal(version.status, 0, version.stderr)
    assert.equal(version.stdout.trim(), packageMetadata.version)
    const unknown = spawnSync(process.execPath, [entry, '--unknown'], { cwd: workspace, env, encoding: 'utf8' })
    assert.notEqual(unknown.status, 0)
    assert.match(unknown.stderr, /usage: mini-dsh/)
    assert.equal(await fs.stat(sessionDirectory).then(() => true, () => false), false)
    await fs.unlink(path.join(workspace, '.env'))
    const missing = spawnSync(process.execPath, [entry], { cwd: workspace, env, encoding: 'utf8' })
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /missing DEEPSEEK_API_KEY.*current working directory/)
    assert.doesNotMatch(missing.stderr, /offline-dummy/)
    assert.equal(await fs.stat(sessionDirectory).then(() => true, () => false), false)
  } finally { await fs.rm(workspace, { recursive: true, force: true }) }
})
