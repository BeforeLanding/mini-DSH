import fs from 'node:fs/promises'
import path from 'node:path'
import { memoryHash, recordObject } from './memory-contracts.js'
import { readBoundedMemoryFile } from './memory-retriever.js'
import { boundDelegationBatch, parseChildFindings } from './delegation-contracts.js'
import type { DelegationBatch, DelegationResult } from './delegation-contracts.js'
import type { DelegationDependencies } from './delegation-runtime.js'
import type { DelegationRecovery } from './session-runtime.js'

// Only a persisted, correctly bound built-in delegation manifest is eligible. No child is ever re-run.
export function delegationRecovery(deps: DelegationDependencies): DelegationRecovery {
  return async (sessionId, call, scope) => {
    const events = deps.sessions.get(sessionId).events
    const start = events.find(event => event.type === 'delegation/start' && event.taskId === scope.taskId && event.runId === scope.runId && event.data.toolCallId === call.id && event.data.toolSequence === scope.seq)
    if (start?.type !== 'delegation/start') return undefined
    await deps.group(sessionId, scope.taskId!)
    const results: DelegationResult[] = []
    const directory = path.join(deps.directory, sessionId, start.data.batchId)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    for (const planned of start.data.children) {
      const created = events.find(event => event.type === 'delegation/child-created' && event.data.batchId === start.data.batchId && event.data.delegationId === planned.delegationId)
      const finish = events.find(event => event.type === 'delegation/child-finish' && event.data.batchId === start.data.batchId && event.data.delegationId === planned.delegationId)
      const childSessionId = created?.type === 'delegation/child-created' ? created.data.childSessionId : undefined
      const target = path.join(directory, `${planned.delegationId}.json`)
      let result: DelegationResult
      let bytes: Buffer | undefined
      try { bytes = await readBoundedMemoryFile(target, start.data.limits.maxResultBytes) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined }
      if (bytes) {
        let parsed: unknown
        try { parsed = JSON.parse(bytes.toString('utf8')) } catch { return undefined }
        if (!recordObject(parsed) || parsed.delegationId !== planned.delegationId || parsed.childSessionId !== childSessionId || !['completed', 'failed', 'cancelled', 'interrupted', 'invalid_result', 'skipped', 'stale'].includes(String(parsed.status))) return undefined
        try { parseChildFindings(JSON.stringify({ findings: parsed.findings, unresolved: parsed.unresolved }), start.data.limits) } catch { return undefined }
        result = parsed as unknown as DelegationResult
        if (result.status === 'completed' && !childSessionId) return undefined
      } else {
        if (finish) return undefined
        result = { delegationId: planned.delegationId, ...(childSessionId ? { childSessionId } : {}), status: childSessionId ? 'interrupted' : 'skipped', findings: [], unresolved: ['Recovered without a confirmed child result. No request was re-dispatched.'] }
        bytes = Buffer.from(JSON.stringify(result))
        const file = await fs.open(target, 'wx', 0o600)
        try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      }
      const resultSha256 = memoryHash(bytes)
      if (finish?.type === 'delegation/child-finish') {
        if (finish.data.resultSha256 !== resultSha256 || finish.data.status !== result.status) return undefined
        try {
          const copy = await deps.results.read(sessionId, finish.data.resultRef, 0, start.data.limits.maxResultBytes, new AbortController().signal)
          if (!copy.eof || memoryHash(copy.content) !== resultSha256) return undefined
        } catch { return undefined }
        result = { ...result, resultRef: finish.data.resultRef, resultSha256 }
      } else {
        const published = await deps.results.save(sessionId, bytes.toString('utf8'), new AbortController().signal)
        deps.sessions.append(sessionId, 'delegation/child-finish', { batchId: start.data.batchId, delegationId: planned.delegationId, ...(childSessionId ? { childSessionId } : {}), status: result.status, resultRef: published.ref, resultSha256 }, scope)
        await deps.sessions.flush(sessionId)
        result = { ...result, resultRef: published.ref, resultSha256 }
      }
      results.push(result)
    }
    const existing = events.find(event => event.type === 'delegation/finish' && event.data.batchId === start.data.batchId)
    const batch: DelegationBatch = boundDelegationBatch({ batchId: start.data.batchId, results, truncated: false }, start.data.limits)
    const content = existing?.type === 'delegation/finish' ? existing.data.result : JSON.stringify(batch)
    if (existing?.type === 'delegation/finish' && JSON.stringify(batch) !== existing.data.result) return undefined
    if (!existing) {
      deps.sessions.append(sessionId, 'delegation/finish', { batchId: start.data.batchId, toolCallId: call.id, toolSequence: scope.seq, result: content }, scope)
      await deps.sessions.flush(sessionId)
    }
    return { content, isError: results.some(result => result.status !== 'completed') }
  }
}
