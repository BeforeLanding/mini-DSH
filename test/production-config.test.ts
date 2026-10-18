import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { productionHarnessConfig } from '../src/app/production-config.js'
import { createHarness } from '../src/app/create-harness.js'

test('production defaults and explicit context/preview choices use the shared harness', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-production-config-'))
  try {
    const defaults = productionHarnessConfig({}, workspace)
    assert.equal(defaults.profile, 'coding')
    assert.equal(defaults.contextLayout, 'live')
    assert.equal(defaults.toolOutputMaxPreviewBytes, undefined)
    const live = await createHarness(defaults)
    try {
      assert.equal(live.capabilityManifest.policy.contextLayout, 'live')
      assert.equal(live.capabilityManifest.policy.toolOutputMaxPreviewBytes, null)
      assert.ok(live.capabilityManifest.tools.includes('read_history'))
    } finally { await live.dispose() }

    const chosen = productionHarnessConfig({ MINI_DSH_CONTEXT_LAYOUT: 'frozen', MINI_DSH_TOOL_PREVIEW_BYTES: '32768' }, workspace)
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
  for (const preview of ['', '0', '-1', '1.5', 'Infinity', '9007199254740992']) assert.throws(() => productionHarnessConfig({ MINI_DSH_TOOL_PREVIEW_BYTES: preview }), /MINI_DSH_TOOL_PREVIEW_BYTES/)
})

test('frozen time and project rules last for the harness lifetime, while project_context reads fresh rules', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-frozen-lifecycle-'))
  const rules = path.join(workspace, 'AGENTS.md')
  await fs.writeFile(rules, 'first-rule', 'utf8')
  let clock = 0
  const make = () => createHarness({ ...productionHarnessConfig({ MINI_DSH_CONTEXT_LAYOUT: 'frozen' }, workspace), runtimeTime: () => `clock-${++clock}` })
  try {
    const first = await make()
    try {
      const initial = await first.root.systemPrompt.assemble()
      assert.match(initial, /first-rule/)
      assert.match(initial, /clock-1/)
      await fs.writeFile(rules, 'second-rule', 'utf8')
      const anotherSession = first.root.sessions.create()
      assert.ok(anotherSession.id)
      assert.equal(await first.root.systemPrompt.assemble(), initial, 'new session does not refresh a frozen harness')
      const current = await first.root.tools.get('project_context')!.execute({}, { signal: new AbortController().signal })
      assert.match(JSON.stringify(current), /second-rule/)
      assert.doesNotMatch(JSON.stringify(current), /first-rule/)
    } finally { await first.dispose() }
    const restarted = await make()
    try {
      const refreshed = await restarted.root.systemPrompt.assemble()
      assert.match(refreshed, /second-rule/)
      assert.match(refreshed, /clock-2/)
    } finally { await restarted.dispose() }
  } finally { await fs.rm(workspace, { recursive: true, force: true }) }
})
