import { resolveInside } from '../utils/path.js'
import { contentHash } from './content-hash.js'
import { readBoundedFile } from './bounded-file.js'
import type { ReviewCandidate } from './delegation-contracts.js'
export async function reviewValidity(workspace: string, candidate: ReviewCandidate): Promise<'current' | 'stale'> {
  if (candidate.digest !== contentHash(JSON.stringify(candidate.anchors))) return 'stale'
  for (const anchor of candidate.anchors) try {
    const bytes = await readBoundedFile(resolveInside(workspace, anchor.path), 1024 * 1024)
    if (contentHash(bytes) !== anchor.contentSha256) return 'stale'
  } catch { return 'stale' }
  return 'current'
}
