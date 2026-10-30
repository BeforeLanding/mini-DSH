import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHarness } from '../src/app/create-harness.js'

test('production and all four v2 arms expose the same tool schemas', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-composition-'))
  const instances: Awaited<ReturnType<typeof createHarness>>[] = []
  try {
    const adapter = { provider: 'scripted', model: 'fixture', chat: async () => ({ content: 'done' }) }
    const base = { workspace, profile: 'coding' as const, adapter, autoApprove: true }
    const production = await createHarness({ workspace, profile: 'coding' })
    instances.push(production)
    assert.equal(production.capabilityManifest.tools.some(name => /^(memory_|delegate_tasks$|review_status$)/.test(name)), false,
      'main must not expose the memory/team feature-branch tools')
    for (const key of ['memory', 'delegation', 'taskGroups']) assert.equal(Object.hasOwn(production, key), false)
    for (const [bounded, frozen] of [[false, false], [true, false], [false, true], [true, true]]) {
      const instance = await createHarness({ ...base, contextLayout: frozen ? 'frozen' : 'live', toolOutputMaxPreviewBytes: bounded ? undefined : 64 * 1024 * 1024 })
      instances.push(instance)
      assert.equal(instance.capabilityManifest.toolSchemaSha256, production.capabilityManifest.toolSchemaSha256)
      assert.deepEqual(instance.capabilityManifest.tools, production.capabilityManifest.tools)
      assert.ok(instance.capabilityManifest.tools.includes('read_history'))
    }
    const legacy = await createHarness({ ...base, legacyNoReadHistory: true })
    instances.push(legacy)
    assert.ok(!legacy.capabilityManifest.tools.includes('read_history'))
    assert.notEqual(legacy.capabilityManifest.toolSchemaSha256, production.capabilityManifest.toolSchemaSha256)
  } finally {
    for (const instance of instances.reverse()) await instance.dispose()
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('the paid runner rejects a historical manifest before any runtime or provider access', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-old-manifest-'))
  try {
    const manifest = path.join(workspace, 'manifest.json')
    await fs.writeFile(manifest, JSON.stringify({ protocol: 'NX-42-eval-v2' }))
    const runner = new URL('../scripts/eval-v2-run.js', import.meta.url)
    const result = spawnSync(process.execPath, [fileURLToPath(runner), '--manifest', manifest, '--validate-only'], { encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '' } })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /historical V2 manifest cannot run/)
  } finally { await fs.rm(workspace, { recursive: true, force: true }) }
})
