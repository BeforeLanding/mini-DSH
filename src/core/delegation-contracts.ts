import { recordObject, sha256 } from './memory-contracts.js'
import { estimateText } from './token-estimator.js'

export type ChildRole = 'analyst' | 'test_designer'
export interface DelegateTaskInput { role: ChildRole; objective: string; contextRefs: string[]; outputFocus: string }
export interface AgentFinding { kind: 'observation' | 'hypothesis' | 'recommendation'; text: string; evidence: { path: string; contentSha256: string; line?: number }[] }
export interface ChildFindings { findings: AgentFinding[]; unresolved: string[] }
export interface DelegationLimits {
  maxConcurrent: number; maxChildrenPerTask: number; childMaxModelRequests: number; childMaxToolCalls: number; childMaxTotalTokens: number
  maxResultTokens: number; maxResultBytes: number; maxBatchResultTokens: number; maxBatchResultBytes: number
}
export const DELEGATION_LIMITS: Readonly<DelegationLimits> = Object.freeze({ maxConcurrent: 2, maxChildrenPerTask: 4, childMaxModelRequests: 8, childMaxToolCalls: 16, childMaxTotalTokens: 200_000, maxResultTokens: 1536, maxResultBytes: 8192, maxBatchResultTokens: 4096, maxBatchResultBytes: 16384 })
export interface PlannedChild { delegationId: string; task: DelegateTaskInput }
export interface DelegationStart { batchId: string; groupId: string; toolCallId: string; toolSequence: number; children: PlannedChild[]; anchors: { path: string; contentSha256: string }[]; limits: DelegationLimits }
export type ChildStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'invalid_result' | 'skipped'
export interface DelegationResult { delegationId: string; childSessionId?: string; status: ChildStatus; findings: AgentFinding[]; unresolved: string[]; resultRef?: string; resultSha256?: string; summaryTruncated?: boolean }
export interface DelegationBatch { batchId: string; results: DelegationResult[]; truncated: boolean }
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= max
export function delegationLimits(overrides: Partial<DelegationLimits> = {}): Readonly<DelegationLimits> {
  const limits = { ...DELEGATION_LIMITS, ...overrides }
  for (const [key, value] of Object.entries(limits)) if (!(key in DELEGATION_LIMITS) || !Number.isSafeInteger(value) || value < 1) throw new Error(`invalid delegation limit: ${key}`)
  if (limits.maxConcurrent > 2 || limits.maxChildrenPerTask > 4) throw new Error('first-version delegation supports at most two concurrent and four cumulative children')
  return Object.freeze(limits)
}
export function delegateInputs(value: unknown): DelegateTaskInput[] {
  if (!Array.isArray(value) || !value.length || value.length > 4) throw new Error('delegate_tasks requires one to four independent tasks')
  return value.map(item => {
    if (!recordObject(item) || !['analyst', 'test_designer'].includes(String(item.role)) || !bounded(item.objective, 4096) || !bounded(item.outputFocus, 1024) || !Array.isArray(item.contextRefs) || item.contextRefs.length > 16 || !item.contextRefs.every(ref => bounded(ref, 1024))) throw new Error('invalid read-only child task')
    return structuredClone(item) as unknown as DelegateTaskInput
  })
}
export function parseChildFindings(text: string, limits: DelegationLimits): ChildFindings {
  if (Buffer.byteLength(text) > limits.maxResultBytes || estimateText(text) > limits.maxResultTokens) throw new Error('child result limit exceeded')
  const data: unknown = JSON.parse(text)
  if (!recordObject(data) || !Array.isArray(data.findings) || data.findings.length > 16 || !Array.isArray(data.unresolved) || data.unresolved.length > 16 || !data.unresolved.every(item => bounded(item, 512))) throw new Error('invalid child result')
  for (const finding of data.findings) {
    if (!recordObject(finding) || !['observation', 'hypothesis', 'recommendation'].includes(String(finding.kind)) || !bounded(finding.text, 2048) || !Array.isArray(finding.evidence) || finding.evidence.length > 8 || (finding.kind === 'observation' && !finding.evidence.length) || !finding.evidence.every(ref => recordObject(ref) && bounded(ref.path, 1024) && sha256(ref.contentSha256) && (ref.line === undefined || (Number.isSafeInteger(ref.line) && Number(ref.line) >= 1)))) throw new Error('invalid finding evidence')
  }
  return data as unknown as ChildFindings
}
export function boundDelegationBatch(batch: DelegationBatch, limits: DelegationLimits) {
  const fits = () => { const text = JSON.stringify(batch); return Buffer.byteLength(text) <= limits.maxBatchResultBytes && estimateText(text) <= limits.maxBatchResultTokens }
  while (!fits()) {
    const result = batch.results.find(item => item.findings.length || item.unresolved.length)
    if (!result) throw new Error('delegation batch limit cannot fit status and references')
    if (result.findings.length) result.findings.pop(); else result.unresolved.pop()
    result.summaryTruncated = true; batch.truncated = true
  }
  return batch
}
