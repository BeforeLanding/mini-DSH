import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as systemPrompt from '../src/plugins/system-prompt.js'
import * as runtimeContext from '../src/plugins/runtime-context.js'

test('runtime context preserves the general default and disposes registered prompt entries', async () => {
  const root = new Context()
  try {
    await root.plugin(systemPrompt)
    const plugin = await root.plugin(runtimeContext, { workspace: 'synthetic-workspace' })
    const prompt = await root.systemPrompt.assemble()
    assert.match(prompt, /general-purpose agent/)
    assert.match(prompt, /Reply in English by default/)
    assert.match(prompt, /Runtime Context/)
    await plugin.dispose()
    assert.equal(await root.systemPrompt.assemble(), '')
    assert.deepEqual(root.systemPrompt.inspect(), { sections: [], contexts: [] })
  } finally { await root.fiber.dispose() }
})

test('coding profile preserves changes, respects scoped rules and requires actual verification evidence', async () => {
  const root = new Context()
  try {
    await root.plugin(systemPrompt)
    await root.plugin(runtimeContext, { profile: 'coding', workspace: 'synthetic-workspace' })
    const prompt = await root.systemPrompt.assemble()
    assert.match(prompt, /coding agent/)
    assert.match(prompt, /user's language/)
    assert.match(prompt, /Preserve user changes/)
    assert.match(prompt, /directory scope/)
    assert.match(prompt, /cannot expand Harness permissions/)
    assert.match(prompt, /completed run is not proof/)
    assert.match(prompt, /Do not install dependencies or execute scripts merely/)
    assert.match(prompt, /read-only question/)
    assert.doesNotMatch(prompt, /general-purpose agent|Reply in English by default/)
  } finally { await root.fiber.dispose() }
})

test('invalid coding profile fails before registering prompt entries', async () => {
  const root = new Context()
  try {
    await root.plugin(systemPrompt)
    await assert.rejects(async () => { await root.plugin(runtimeContext, { profile: 'invalid' as 'coding' }) }, /profile must/)
    assert.deepEqual(root.systemPrompt.inspect(), { sections: [], contexts: [] })
  } finally { await root.fiber.dispose() }
})
