import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { PassThrough } from 'node:stream'
import { createHarness } from '../src/app/create-harness.js'
import { productionHarnessConfig } from '../src/app/production-config.js'
import { inspectProductionConfig } from '../src/app/config-inspection.js'
import { JsonlStore, parseLog } from '../src/core/event-store.js'
import { memoryDigest, memoryHash } from '../src/core/memory-contracts.js'
import { inspectSession } from '../src/core/session-inspect.js'
import type { MemoryRecord } from '../src/core/memory-contracts.js'
import * as cli from '../src/plugins/cli.js'

test('shared Harness supports proposal, human review, new-task recall and durable frozen view recovery', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-harness-')), workspace = path.join(directory, 'project')
  await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'entry.ts'), 'entry')
  const config = { workspace, profile: 'coding' as const, memory: { mode: 'assist' as const, directory: path.join(directory, 'memory') } }
  const harness = await createHarness(config)
  t.after(async () => { await harness.dispose(); await fs.rm(directory, { recursive: true, force: true }) })
  const { root } = harness, session = root.sessions.create({ workspace })
  const logs = path.join(directory, 'sessions'), eventStore = await JsonlStore.open(logs, session.id)
  root.sessions.attachStore(session.id, eventStore)
  let requests = 0
  root.llm.register('scripted', { models: ['test'], chat: async () => {
    if (++requests === 1) {
      const source = root.sessions.get(session.id).events.find(event => event.type === 'user/message')!
      return { toolCalls: [{ id: 'remember-entry', name: 'memory_propose', arguments: { kind: 'project_fact', key: 'entry', title: 'Module entry', content: 'entry.ts defines the module', sources: [{ seq: source.seq }], anchors: [{ path: 'entry.ts', contentSha256: memoryHash('entry') }] } }] }
    }
    return { content: 'done' }
  } })
  const agent = root.agents.create({ sessionId: session.id, model: 'scripted/test', loop: root.agentLoop })
  await agent.send('Investigate the module entry and propose reusable knowledge.')
  const records = await harness.memory!.runtime.store.records()
  assert.equal(records.length, 1); assert.equal(records[0].state, 'candidate')
  assert.equal((await harness.memory!.query(session.id, 'module')).items.length, 0)
  // That direct query was after the run; it must never be committed to the durable log as an in-run event.
  const review = await harness.memory!.command(['review']) as { items: { record: MemoryRecord; digest: string }[] }
  assert.equal(review.items[0].digest, memoryDigest(records[0]))
  await harness.memory!.command(['approve', records[0].id, '1', review.items[0].digest])
  assert.equal(root.tools.get('memory_approve'), undefined)
  assert.equal((await root.tools.execute('memory_approve')).isError, true)
  await agent.send('New task: recall module knowledge.')
  const state = root.sessions.latestRun(session.id)!
  const query = await root.tools.execute('memory_search', { query: 'module' }, { sessionId: session.id })
  assert.equal((query.value as { items: MemoryRecord[] }).items.length, 1)
  const logText = root.sessions.get(session.id).events.map(event => JSON.stringify(event) + '\n').join('')
  // Only running task query receipts are appended; direct post-run inspection is read-only.
  parseLog(logText, session.id)
  await root.sessions.flush(session.id); await root.sessions.close(); await harness.dispose()
  const recovered = await createHarness(config)
  try {
    const restoredStore = await JsonlStore.open(logs, session.id)
    await recovered.root.sessions.restore(restoredStore, workspace)
    const view = await recovered.memory!.view(session.id)
    assert.equal((await recovered.memory!.runtime.search(view, 'module')).items.length, 1)
    const approved = (await recovered.memory!.runtime.store.get(records[0].id))!
    await recovered.memory!.command(['forget', approved.id, String(approved.revision)])
    assert.equal((await recovered.memory!.runtime.get(view, approved.id)).items.length, 0)
    assert.equal(recovered.root.sessions.latestRun(session.id)?.taskId, state.taskId)
    const report = await inspectSession(path.join(logs, session.id, 'events.jsonl'))
    assert.equal(report.integrity.complete, true)
    await recovered.root.sessions.close()
  } finally { await recovered.dispose() }
})

test('memory defaults remain absent, show-config does not create storage, and recall role has no proposal tool', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-config-')), workspace = path.join(directory, 'project'), memoryDirectory = path.join(directory, 'memory')
  await fs.mkdir(workspace)
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const plain = await createHarness(productionHarnessConfig({}, workspace))
  try { assert.equal(plain.memory, undefined); assert.ok(!plain.capabilityManifest.tools.some(name => name.startsWith('memory_'))); assert.ok(!(await plain.root.systemPrompt.assemble({})).includes('Project memory')) } finally { await plain.dispose() }
  const inspected = await inspectProductionConfig({ MINI_DSH_MEMORY: 'assist', MINI_DSH_MEMORY_DIR: memoryDirectory, MINI_DSH_MCP: '0' }, () => 'environment', workspace)
  assert.equal(inspected.memory.mode, 'assist'); await assert.rejects(fs.stat(memoryDirectory), { code: 'ENOENT' })
  const read = await createHarness({ workspace, profile: 'coding', memory: { mode: 'recall', directory: memoryDirectory } })
  try { assert.ok(read.root.tools.get('memory_search')); assert.equal(read.root.tools.get('memory_propose'), undefined) } finally { await read.dispose() }
  assert.throws(() => productionHarnessConfig({ MINI_DSH_MEMORY: 'automatic' }), /MINI_DSH_MEMORY/)
  assert.throws(() => productionHarnessConfig({ MINI_DSH_DELEGATION: 'swarm' }), /MINI_DSH_DELEGATION/)
  assert.throws(() => productionHarnessConfig({ MINI_DSH_DELEGATION: 'read-only', MINI_DSH_TEAM_LIMITS: '{"maxConcurrent":10}' }), /at most two/)
  assert.throws(() => productionHarnessConfig({ MINI_DSH_TASK_GROUP_BUDGET: '[]' }), /JSON object/)
  const teamDirectory = path.join(directory, 'teams')
  const teamConfig = await inspectProductionConfig({ MINI_DSH_DELEGATION: 'read-only', MINI_DSH_TEAM_DIR: teamDirectory, MINI_DSH_MCP: '0' }, () => 'environment', workspace)
  assert.equal(teamConfig.delegation.mode, 'read-only')
  assert.ok(teamConfig.tools.includes('delegate_tasks'))
  await assert.rejects(fs.stat(teamDirectory), { code: 'ENOENT' })
})

test('memory rejects malformed, excessive and secret-bearing proposals while CLI exposes review without a model request', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-cli-')), workspace = path.join(directory, 'project')
  await fs.mkdir(workspace)
  const h = await createHarness({ workspace, profile: 'coding', memory: { mode: 'assist', directory: path.join(directory, 'memory') } })
  t.after(async () => { await h.dispose(); await fs.rm(directory, { recursive: true, force: true }) })
  const s = h.root.sessions.create({ workspace }), state = h.root.sessions.beginRun(s.id, {}, 'scripted/test')
  const source = h.root.sessions.append(s.id, 'user/message', { content: 'Reusable module lesson' }, state)
  const base = { kind: 'episode', key: 'lesson', title: 'Lesson', content: 'Read module first', sources: [{ seq: source.seq }], anchors: [] }
  for (let i = 0; i < 3; i++) assert.equal((await h.root.tools.execute('memory_propose', { ...base, key: `lesson${i}` }, { sessionId: s.id, toolCallId: `p${i}` })).isError, false)
  assert.equal((await h.root.tools.execute('memory_propose', base, { sessionId: s.id, toolCallId: 'p3' })).isError, true)
  // Receipt replay does not create a fourth record.
  assert.equal((await h.root.tools.execute('memory_propose', { ...base, key: 'lesson0' }, { sessionId: s.id, toolCallId: 'p0' })).isError, false)
  h.root.sessions.finishRun(state, 'completed')
  const second = h.root.sessions.beginRun(s.id, {}, 'scripted/test')
  const newSource = h.root.sessions.append(s.id, 'user/message', { content: 'New source' }, second)
  assert.equal((await h.root.tools.execute('memory_propose', { ...base, sources: [{ seq: newSource.seq }], content: 'api_key=abcdefghijklmnopqrstuvwxyz' }, { sessionId: s.id, toolCallId: 'secret' })).isError, true)
  h.root.sessions.finishRun(second, 'completed')
  const input = new PassThrough(), output = new PassThrough(); let text = ''
  output.on('data', chunk => { text += String(chunk) })
  h.root.llm.register('scripted', { models: ['test'], capabilities: { test: { contextWindowTokens: 1_000_000 } }, chat: async () => { throw new Error('CLI review must not call a model') } })
  await h.root.plugin(cli, { input, output, sessionDirectory: false, memory: h.memory })
  input.write('/memory review\n/exit\n')
  await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('CLI memory review timeout')), 5000); output.on('data', () => { if (text.includes('"candidate"')) { clearTimeout(timeout); resolve() } }) })
  assert.match(text, /"digest"/)
})
