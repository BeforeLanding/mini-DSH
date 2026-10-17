import fs from 'node:fs/promises'
import path from 'node:path'
import { createHarness } from '../src/app/create-harness.js'
import { JsonlStore } from '../src/core/event-store.js'
import { createFixture } from './coding-fixtures.js'
import { createIsolatedCommandRunner } from './eval-v2-isolation.js'
import { createSmokeRecorder } from './smoke-recording.js'
import { smokeBudget, type SmokeScenario } from './smoke-plan.js'
import type { SmokeManifest } from './smoke-manifest.js'
import type { Adapter, SessionEvent } from '../src/core/contracts.js'

export interface SmokeEnvironment { manifest: SmokeManifest; evidenceRoot: string; runtimeRoot: string; adapter: Adapter }
const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, source: 'provider' as const, uncertain: false })

function recorderFor(env: SmokeEnvironment, scenario: SmokeScenario, workspace: string) {
  return createSmokeRecorder({ file: path.join(env.evidenceRoot, scenario.id, 'recording.jsonl'), workspace,
    version: { codeSHA: env.manifest.codeSHA, fixtureId: scenario.fixture, manifestDigest: env.manifest.digest, toolSchemaSha256: env.manifest.toolSchemaSha256 }, wire: env.manifest.wire,
    limits: { main: scenario.maxMainRequests, summary: scenario.maxSummaryRequests, maxTotalTokens: scenario.maxTotalTokens, maxMainOutputTokens: scenario.maxOutputTokens,
      maxSummaryOutputTokens: scenario.maxSummaryOutputTokens, maxWallDurationMs: scenario.maxWallDurationMs, requireProviderUsage: true }, delegate: env.adapter.chat })
}

export async function runProtocolSmoke(env: SmokeEnvironment, scenario: SmokeScenario) {
  const directory = path.join(env.evidenceRoot, scenario.id)
  await fs.mkdir(directory)
  const workspace = path.join(directory, 'fixture')
  await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, 'sentinel.txt'), 'synthetic protocol fixture\n', { flag: 'wx' })
  const recorder = recorderFor(env, scenario, workspace)
  const request = { purpose: 'main' as const, model: env.manifest.model, maxOutputTokens: scenario.maxOutputTokens,
    signal: AbortSignal.timeout(scenario.requestTimeoutMs), system: 'Protocol smoke: return a brief, complete response.', messages: [{ role: 'user' as const, content: 'Reply with OK.' }] }
  try {
    const first = await recorder.chat(request)
    if (first.observedModel !== env.manifest.echoedModel || first.complete !== true || first.finishReason !== 'stop' || first.usage?.source !== 'provider') throw new Error('protocol first response missing echoed model, complete finish or provider usage')
    const second = await recorder.chat({ ...request, signal: AbortSignal.timeout(scenario.requestTimeoutMs), system: 'Protocol smoke: call the supplied echo_probe tool once.', messages: [{ role: 'user', content: 'Call echo_probe with value OK.' }],
      tools: [{ type: 'function', function: { name: 'echo_probe', description: 'Synthetic protocol probe, never executed', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } }] })
    if (second.observedModel !== env.manifest.echoedModel || second.complete !== true || second.finishReason !== 'tool_calls' || second.toolCalls?.[0]?.name !== 'echo_probe' || second.usage?.source !== 'provider') throw new Error('protocol tool stream/usage/model echo failed')
    return { status: 'passed', counts: recorder.counts, totalTokens: recorder.totalTokens, first: { finishReason: first.finishReason, observedModel: first.observedModel, usage: first.usage }, second: { finishReason: second.finishReason, observedModel: second.observedModel, usage: second.usage } }
  } finally { recorder.close() }
}

function adapterFor(env: SmokeEnvironment, recorder: ReturnType<typeof createSmokeRecorder>) {
  return { provider: 'deepseek', model: env.manifest.model, chat: recorder.chat, capabilities: { [env.manifest.model]: { contextWindowTokens: 1_000_000 } } }
}
function eventEvidence(events: readonly SessionEvent[]) {
  return { status: events.filter(event => event.type === 'run/finish').map(event => event.data.state.status),
    toolCalls: events.filter(event => event.type === 'tool/start').map(event => ({ seq: event.seq, name: event.data.name })),
    summaries: events.filter(event => event.type === 'context/summary-end').map(event => ({ seq: event.seq, outcome: event.data.outcome.kind })) }
}

export async function runRecallSmoke(env: SmokeEnvironment, scenario: SmokeScenario) {
  const startedAt = Date.now()
  const directory = path.join(env.evidenceRoot, scenario.id)
  await fs.mkdir(directory)
  const workspace = path.join(directory, 'fixture')
  await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, 'README.txt'), 'Synthetic history smoke. No external files.\n', { flag: 'wx' })
  const recorder = recorderFor(env, scenario, workspace)
  const harness = await createHarness({ workspace, profile: 'coding', autoApprove: true, adapter: adapterFor(env, recorder), commandRunner: createIsolatedCommandRunner({ workspace, runtimeRoot: env.runtimeRoot, distro: 'Ubuntu' }) })
  const session = harness.root.sessions.create({ source: 'smoke', fixtureId: scenario.fixture })
  const store = await JsonlStore.open(path.join(directory, 'sessions'), session.id)
  harness.root.sessions.attachStore(session.id, store)
  const budget = smokeBudget(scenario)
  const agent = harness.root.agents.create({ sessionId: session.id, model: `deepseek/${env.manifest.model}`, loop: harness.root.agentLoop, budget })
  const marker = 'blue-lantern-7319'
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), scenario.maxWallDurationMs)
  try {
    const seed = harness.root.sessions.beginRun(session.id, budget, `deepseek/${env.manifest.model}`)
    harness.root.sessions.append(session.id, 'user/message', { content: 'Remember the synthetic audit detail for a later question.' }, seed)
    harness.root.sessions.append(session.id, 'assistant/tool_calls', { toolCalls: [{ id: 'seed-read', name: 'read_file', arguments: { path: 'README.txt' } }] }, seed)
    const hidden = `The audit marker is ${marker}.\n${'synthetic ledger row 0123456789 abcdef\n'.repeat(8000)}`
    const fact = harness.root.sessions.append(session.id, 'tool/result', { toolCallId: 'seed-read', name: 'read_file', content: hidden }, seed)
    harness.root.sessions.append(session.id, 'assistant/message', { content: 'The next request should consult archived history.' }, seed)
    harness.root.sessions.finishRun(seed, 'max_steps')
    await harness.root.sessions.flush(session.id)
    const applied = await harness.root.agentLoop.compact(agent, { budget, signal: abort.signal })
    if (!applied) throw new Error('explicit compaction did not apply')
    await agent.send(`Use read_history to inspect event ${fact.seq}; report the exact audit marker from that event.`, { signal: abort.signal, budget })
    await harness.root.sessions.flush(session.id)
    const events = harness.root.sessions.visibleEvents(session.id)
    const observed = eventEvidence(events)
    const read = events.some(event => event.type === 'tool/start' && event.data.name === 'read_history')
    const answer = events.filter(event => event.type === 'assistant/message').at(-1)
    const passed = read && answer?.type === 'assistant/message' && answer.data.content.includes(marker) && harness.root.sessions.latestRun(session.id)?.status === 'completed' && Date.now() - startedAt <= scenario.maxWallDurationMs
    return { status: passed ? 'passed' : 'failed', counts: recorder.counts, totalTokens: recorder.totalTokens, wallDurationMs: Date.now() - startedAt, compactApplied: applied, targetSeq: fact.seq, markerRecovered: answer?.type === 'assistant/message' && answer.data.content.includes(marker), readHistoryUsed: read, events: observed }
  } finally { clearTimeout(timer); await harness.root.sessions.close(); await harness.dispose(); recorder.close() }
}

export async function runRepairSmoke(env: SmokeEnvironment, scenario: SmokeScenario) {
  const startedAt = Date.now()
  const fixture = await createFixture('repair')
  try {
  const directory = path.join(env.evidenceRoot, scenario.id)
  await fs.mkdir(directory)
  const recorder = recorderFor(env, scenario, fixture.workspace)
  const harness = await createHarness({ workspace: fixture.workspace, profile: 'coding', autoApprove: true, adapter: adapterFor(env, recorder), commandRunner: createIsolatedCommandRunner({ workspace: fixture.workspace, runtimeRoot: env.runtimeRoot, distro: 'Ubuntu' }) })
  const session = harness.root.sessions.create({ source: 'smoke', fixtureId: scenario.fixture })
  const store = await JsonlStore.open(path.join(directory, 'sessions'), session.id)
  harness.root.sessions.attachStore(session.id, store)
  const budget = smokeBudget(scenario)
  const agent = harness.root.agents.create({ sessionId: session.id, model: `deepseek/${env.manifest.model}`, loop: harness.root.agentLoop, budget })
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), scenario.maxWallDurationMs)
  let events: SessionEvent[] = []
  let runError: unknown, evidenceError: unknown, acceptanceError: unknown
  let runStatus = 'unknown'
  try { await agent.send(fixture.tasks[0]!, { signal: abort.signal, budget }) }
  catch (error) { runError = error }
  finally {
    clearTimeout(timer)
    try {
      await harness.root.sessions.flush(session.id)
      events = harness.root.sessions.visibleEvents(session.id)
      runStatus = harness.root.sessions.latestRun(session.id)?.status ?? 'unknown'
    } catch (error) { evidenceError = error }
    try { await harness.root.sessions.close() } catch (error) { evidenceError ??= error }
    try { await harness.dispose() } catch (error) { evidenceError ??= error }
    try { recorder.close() } catch (error) { evidenceError ??= error }
  }
  const candidate = path.join(directory, 'candidate')
  let evidenceStatus: 'saved' | 'save_failed' = 'save_failed'
  if (evidenceError === undefined) {
    try {
      await fs.cp(fixture.workspace, candidate, { recursive: true, errorOnExist: true, force: false })
      evidenceStatus = 'saved'
    } catch (error) { evidenceError = error }
  }
  let artifactAcceptance: 'passed' | 'failed' | 'not_run' | 'error' = 'not_run'
  if (evidenceStatus === 'saved') {
    try { artifactAcceptance = (await fixture.evaluateAt(candidate)).passed ? 'passed' : 'failed' }
    catch (error) { acceptanceError = error; artifactAcceptance = 'error' }
  }
  const unknownSideEffects = events.filter(event => event.type === 'tool/result' && event.data.status === 'unknown').length
  return { status: artifactAcceptance === 'passed' && runStatus === 'completed' && evidenceStatus === 'saved' && !runError && !acceptanceError && unknownSideEffects === 0 && Date.now() - startedAt <= scenario.maxWallDurationMs ? 'passed' : 'failed',
    runStatus, artifactAcceptance, evidenceStatus, runErrorType: runError instanceof Error ? runError.name : runError === undefined ? null : 'unknown',
    evidenceErrorType: evidenceError instanceof Error ? evidenceError.name : evidenceError === undefined ? null : 'unknown',
    acceptanceErrorType: acceptanceError instanceof Error ? acceptanceError.name : acceptanceError === undefined ? null : 'unknown',
    unknownSideEffects, wallDurationMs: Date.now() - startedAt, counts: recorder.counts, totalTokens: recorder.totalTokens, events: eventEvidence(events) }
  } finally { await fixture.close() }
}

// Scripted fixture helper is used only by offline tests. It never contacts a provider.
export const scriptedSmokeUsage = usage
