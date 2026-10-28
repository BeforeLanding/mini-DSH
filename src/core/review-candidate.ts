import { resolveInside } from '../utils/path.js'
import { memoryHash } from './memory-contracts.js'
import { readBoundedMemoryFile } from './memory-retriever.js'
import type { ReviewCandidate } from './delegation-contracts.js'
export async function reviewValidity(workspace: string, candidate: ReviewCandidate): Promise<'current' | 'stale'> {
  if (candidate.digest !== memoryHash(JSON.stringify(candidate.anchors))) return 'stale'
  for (const anchor of candidate.anchors) try {
    const bytes = await readBoundedMemoryFile(resolveInside(workspace, anchor.path), 1024 * 1024)
    if (memoryHash(bytes) !== anchor.contentSha256) return 'stale'
  } catch { return 'stale' }
  return 'current'
}
