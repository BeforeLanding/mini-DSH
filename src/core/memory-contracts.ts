import { createHash } from 'node:crypto'

export type MemoryKind = 'project_fact' | 'procedure' | 'episode'
export interface SourceRef { sessionId: string; taskId: string; eventId: string; seq: number; artifactSha256?: string }
export interface MemoryAnchor { path: string; contentSha256: string }
export interface MemoryRecord {
  id: string; projectId: string; revision: number; kind: MemoryKind; key: string; title: string; content: string; tags: string[]
  state: 'candidate' | 'approved' | 'superseded' | 'revoked'
  sources: SourceRef[]; anchors: MemoryAnchor[]; createdAt: string; approvedAt?: string; expiresAt?: string
  supersedes?: { id: string; revision: number }
}
export type MemoryProposal = Pick<MemoryRecord, 'kind' | 'key' | 'title' | 'content' | 'sources' | 'anchors'> & Partial<Pick<MemoryRecord, 'tags' | 'expiresAt' | 'supersedes'>>
export interface MemoryLimits { maxActiveRecords: number; maxContentBytes: number; maxJournalBytes: number }
export const MEMORY_LIMITS: Readonly<MemoryLimits> = Object.freeze({ maxActiveRecords: 2000, maxContentBytes: 2048, maxJournalBytes: 32 * 1024 * 1024 })
export const memoryDigest = (record: MemoryRecord) => createHash('sha256').update(JSON.stringify(record)).digest('hex')
export const memoryHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export const memoryId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
export const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const recordObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= max
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
export function validateMemoryRecord(value: unknown, limits: MemoryLimits = MEMORY_LIMITS): asserts value is MemoryRecord {
  if (!recordObject(value) || !memoryId(value.id) || !sha256(value.projectId) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 ||
      !['project_fact', 'procedure', 'episode'].includes(String(value.kind)) || !['candidate', 'approved', 'superseded', 'revoked'].includes(String(value.state)) ||
      !text(value.key, 256) || value.key !== value.key.trim().toLowerCase() || !text(value.title, 256) || !text(value.content, limits.maxContentBytes) ||
      !Array.isArray(value.tags) || value.tags.length > 16 || !value.tags.every(tag => text(tag, 64)) ||
      !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 16 || !value.sources.every(source => recordObject(source) && memoryId(source.sessionId) && memoryId(source.taskId) && memoryId(source.eventId) && Number.isSafeInteger(source.seq) && Number(source.seq) >= 1 && (source.artifactSha256 === undefined || sha256(source.artifactSha256))) ||
      !Array.isArray(value.anchors) || value.anchors.length > 16 || !value.anchors.every(anchor => recordObject(anchor) && text(anchor.path, 1024) && !/^(?:[a-z]:|\/|\\)/i.test(anchor.path) && !anchor.path.split(/[\\/]/).includes('..') && sha256(anchor.contentSha256)) ||
      (value.kind !== 'episode' && !value.anchors.length) || !timestamp(value.createdAt) ||
      (value.approvedAt !== undefined && !timestamp(value.approvedAt)) || (value.expiresAt !== undefined && !timestamp(value.expiresAt)) ||
      (value.supersedes !== undefined && (!recordObject(value.supersedes) || !memoryId(value.supersedes.id) || !Number.isSafeInteger(value.supersedes.revision) || Number(value.supersedes.revision) < 1))) throw new Error('invalid memory record')
}
