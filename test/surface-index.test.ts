import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveEventMessage, surfaceSeqs } from '../src/core/compaction-plan.js'
import { assertToolProtocol } from '../src/core/context-runtime.js'
import { SessionRuntime } from '../src/core/session-runtime.js'
import type { SessionEvent } from '../src/core/contracts.js'

// Frozen pre-optimization oracle: compare results, not a timing-dependent speed threshold.
function legacySurface(events: readonly SessionEvent[]) {
  let surface = events.filter(event => deriveEventMessage(event) !== undefined && event.type !== 'context/summary').map(event => event.seq)
  const request = events.find(event => event.type === 'user/message')?.seq
  for (const event of events) {
    if (event.type !== 'context/summary') continue
    const positions = event.data.shadowedSeqs.map(seq => surface.indexOf(seq)).filter(index => index >= 0)
    if (positions.length !== event.data.shadowedSeqs.length) continue
    const start = Math.min(...positions), end = Math.max(...positions)
    if (end - start + 1 !== positions.length) continue
    const shadowed = event.data.shadowedSeqs.map(seq => events.find(candidate => candidate.seq === seq)).filter((candidate): candidate is SessionEvent => candidate !== undefined)
    if (shadowed.some(candidate => candidate.seq === request || (candidate.type === 'tool/result' && candidate.data.status === 'unknown'))) continue
    try { assertToolProtocol(shadowed.flatMap(candidate => { const item = deriveEventMessage(candidate); return item ? [item] : [] })) } catch { continue }
    surface = [...surface.slice(0, start), event.seq, ...surface.slice(end + 1)]
  }
  return surface
}

test('indexed surfaces match legacy projections through nested, missing, gapped and protected summary ranges', () => {
  for (let seed = 1; seed <= 80; seed++) {
    const sessions = new SessionRuntime(), session = sessions.create()
    const scope = { taskId: 'task', runId: 'run' }
    const append: typeof sessions.append = (id, type, data) => sessions.append(id, type, data, scope)
    const user = append(session.id, 'user/message', { content: 'original request' })
    const pairs: number[][] = []
    for (let i = 0; i < 8; i++) {
      const call = append(session.id, 'assistant/tool_calls', { toolCalls: [{ id: `call-${i}`, name: 'probe', arguments: { seed, i } }] })
      const result = append(session.id, 'tool/result', { toolCallId: `call-${i}`, content: 'synthetic', ...(i === seed % 8 ? { status: 'unknown' as const } : {}) })
      pairs.push([call.seq, result.seq])
    }
    const summarize = (seqs: number[]) => append(session.id, 'context/summary', {
      startSeq: 1, trigger: 'explicit', budgetTokens: 2000, projectedTokens: 1800,
      shadowedSeqs: seqs, shadowedTokens: 1000, summaryTokens: 20, retainedNodes: 2, summary: 'summary', frame: 'frame',
    })
    summarize([user.seq, ...pairs[0]!]) // Original request is protected.
    summarize(pairs[seed % 8]!) // Unknown result is protected.
    summarize([pairs[0]![0]!]) // Broken tool protocol.
    summarize([pairs[0]![0]!, pairs[1]![1]!]) // Noncontiguous range.
    summarize([999_999]) // Unavailable sequence.
    let random = seed
    for (let i = 0; i < 12; i++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0
      const visible = legacySurface(session.events)
      const start = 1 + random % Math.max(1, visible.length - 1)
      summarize(visible.slice(start, Math.min(visible.length, start + 2 + random % 6)))
      const before = structuredClone(session.events)
      assert.deepEqual(surfaceSeqs(session.events), legacySurface(session.events), `seed=${seed}, summary=${i}`)
      assert.deepEqual(session.events, before)
    }
  }
})

test('visibility selection does not serialize unshadowed tool arguments', () => {
  let serializations = 0
  const event = { type: 'assistant/tool_calls', seq: 1, data: { toolCalls: [{ id: 'c', name: 'probe',
    arguments: { toJSON() { serializations++; return { synthetic: true } } } }] } } as unknown as SessionEvent
  assert.deepEqual(surfaceSeqs([event]), [1])
  assert.equal(serializations, 0)
})
