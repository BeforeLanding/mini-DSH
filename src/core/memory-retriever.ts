import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveInside } from '../utils/path.js'
import { estimateText } from './token-estimator.js'
import { memoryHash, sha256 } from './memory-contracts.js'
import type { MemoryRecord, SourceRef } from './memory-contracts.js'

export interface MemoryRecallLimits { maxItems: number; maxTokens: number; maxBytes: number; maxCandidateChecks: number; maxAnchorBytes: number; maxSourceBytes: number }
export const MEMORY_RECALL_LIMITS: Readonly<MemoryRecallLimits> = Object.freeze({ maxItems: 5, maxTokens: 2048, maxBytes: 8192, maxCandidateChecks: 64, maxAnchorBytes: 1024 * 1024, maxSourceBytes: 64 * 1024 })
export type MemoryInvalidReason = 'not-visible' | 'not-approved' | 'expired' | 'source-unavailable' | 'anchor-changed' | 'capacity'
export interface MemoryRecall {
  projectId: string; viewDigest: string; queryDigest: string
  items: MemoryRecord[]; filtered: Partial<Record<MemoryInvalidReason, number>>
  candidateLimitReached: boolean
}
export function memoryTerms(text: string) {
  const words = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? []
  return new Set(words.flatMap(word => /\p{Script=Han}/u.test(word) && word.length > 1 ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]))
}
export function memoryScore(record: MemoryRecord, query: Set<string>) {
  const title = memoryTerms([record.key, record.title, ...record.tags, ...record.anchors.map(anchor => anchor.path)].join(' ')), body = memoryTerms(record.content)
  let score = 0
  for (const term of query) score += title.has(term) ? 3 : body.has(term) ? 1 : 0
  return score
}
export async function readBoundedMemoryFile(target: string, maxBytes: number) {
  const file = await fs.open(target, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('memory evidence exceeds file limit')
    const buffer = Buffer.alloc(maxBytes + 1)
    let total = 0
    while (total < buffer.length) { const { bytesRead } = await file.read(buffer, total, buffer.length - total, null); if (!bytesRead) break; total += bytesRead }
    if (total > maxBytes) throw new Error('memory evidence exceeds file limit')
    return buffer.subarray(0, total)
  } finally { await file.close() }
}
export async function validateMemorySource(directory: string, source: SourceRef, maxBytes: number) {
  if (!sha256(source.artifactSha256)) return false
  try {
    const bytes = await readBoundedMemoryFile(path.join(directory, 'sources', `${source.artifactSha256}.json`), maxBytes)
    if (memoryHash(bytes) !== source.artifactSha256) return false
    const artifact = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return artifact.version === 1 && artifact.sessionId === source.sessionId && artifact.taskId === source.taskId && artifact.eventId === source.eventId && artifact.seq === source.seq && artifact.event?.id === source.eventId && artifact.event?.seq === source.seq && artifact.event?.sessionId === source.sessionId && artifact.event?.taskId === source.taskId
  } catch { return false }
}
export async function memoryValidity(record: MemoryRecord, workspace: string, directory: string, limits: MemoryRecallLimits, now: number): Promise<MemoryInvalidReason | undefined> {
  if (record.state !== 'approved') return 'not-approved'
  if (record.expiresAt && Date.parse(record.expiresAt) <= now) return 'expired'
  for (const source of record.sources) if (!await validateMemorySource(directory, source, limits.maxSourceBytes)) return 'source-unavailable'
  for (const anchor of record.anchors) {
    try {
      const target = resolveInside(workspace, anchor.path), bytes = await readBoundedMemoryFile(target, limits.maxAnchorBytes)
      if (memoryHash(bytes) !== anchor.contentSha256 || resolveInside(workspace, anchor.path) !== target) return 'anchor-changed'
    } catch { return 'anchor-changed' }
  }
}
export function fitMemoryRecall(result: MemoryRecall, limits: MemoryRecallLimits) {
  const fits = () => { const text = JSON.stringify(result); return Buffer.byteLength(text) <= limits.maxBytes && estimateText(text) <= limits.maxTokens }
  while (!fits() && result.items.length) { result.items.pop(); result.filtered.capacity = (result.filtered.capacity ?? 0) + 1 }
  if (!fits()) throw new Error('memory return limits cannot fit metadata')
  return result
}
