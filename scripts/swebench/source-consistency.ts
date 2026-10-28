// Comparison helpers for the pinned SWE-bench candidate checkout.
//
// The official images commit an environment commit on top of the dataset base.
// Some image build steps change file modes for every tracked path (for example a
// recursive chmod). A tree-hash comparison treats those as source differences
// even though every blob is byte-identical. The candidate may accept the image
// checkout only when a recursive path-by-path object comparison proves content
// equality; mode differences are recorded, never silently discarded.

export interface TreeEntry { mode: string; type: string; object: string; path: string }

export interface SourceDifference {
  path: string
  kind: 'content' | 'added' | 'removed'
  image?: TreeEntry
  base?: TreeEntry
}

export interface ModeDifference { path: string; imageMode: string; baseMode: string }

export interface SourceComparison {
  contentEqual: boolean
  differences: SourceDifference[]
  modeDifferences: ModeDifference[]
  modeTransitions: Record<string, number>
  imageEntries: number
  baseEntries: number
}

export interface RawDiffEntry {
  oldMode: string
  newMode: string
  oldObject: string
  newObject: string
  status: string
  path: string
}

export interface RawDiffSummary {
  entries: number
  contentChanges: number
  statuses: Record<string, number>
}

const OID = '[0-9a-f]{40,64}'

/** Parse `git ls-tree -r -z --full-tree` output (NUL separated records). */
export function parseTreeListing(output: string): TreeEntry[] {
  const entries: TreeEntry[] = []
  for (const record of output.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    if (tab < 0) throw new Error(`invalid git ls-tree record: ${record.slice(0, 120)}`)
    const fields = record.slice(0, tab).split(' ')
    const [mode, type, object] = fields
    if (fields.length !== 3 || !mode || !type || !object || !/^\d{6}$/.test(mode) ||
      !/^(?:blob|tree|commit)$/.test(type) || !new RegExp(`^${OID}$`).test(object)) {
      throw new Error(`invalid git ls-tree record: ${record.slice(0, 120)}`)
    }
    const path = record.slice(tab + 1)
    if (!path) throw new Error('invalid git ls-tree record: empty path')
    entries.push({ mode, type, object, path })
  }
  return entries
}

/** Parse `git diff-tree -r --raw --no-commit-id` output (one entry per line). */
export function parseRawDiff(output: string): RawDiffEntry[] {
  const entries: RawDiffEntry[] = []
  for (const line of output.split('\n')) {
    if (!line) continue
    const tab = line.indexOf('\t')
    const header = tab < 0 ? line : line.slice(0, tab)
    const path = tab < 0 ? '' : line.slice(tab + 1)
    const match = new RegExp(`^:(\\d{6}) (\\d{6}) ${OID} ${OID} ([A-Z][0-9]*)$`).exec(header)
    if (!match || !path) throw new Error(`invalid git diff-tree record: ${line.slice(0, 120)}`)
    const [, oldMode, newMode, status] = match
    const objects = header.split(' ').slice(2, 4)
    entries.push({ oldMode: oldMode!, newMode: newMode!, oldObject: objects[0]!, newObject: objects[1]!,
      status: status!, path })
  }
  return entries
}

export function compareSourceTrees(base: TreeEntry[], image: TreeEntry[]): SourceComparison {
  const baseByPath = new Map(base.map(entry => [entry.path, entry]))
  const imageByPath = new Map(image.map(entry => [entry.path, entry]))
  if (baseByPath.size !== base.length || imageByPath.size !== image.length) {
    throw new Error('duplicate paths in git tree listing')
  }
  const differences: SourceDifference[] = []
  const modeDifferences: ModeDifference[] = []
  const modeTransitions: Record<string, number> = {}
  for (const [path, baseEntry] of baseByPath) {
    const imageEntry = imageByPath.get(path)
    if (!imageEntry) {
      differences.push({ path, kind: 'removed', base: baseEntry })
      continue
    }
    if (baseEntry.type !== imageEntry.type || baseEntry.object !== imageEntry.object) {
      differences.push({ path, kind: 'content', base: baseEntry, image: imageEntry })
      continue
    }
    if (baseEntry.mode !== imageEntry.mode) {
      modeDifferences.push({ path, imageMode: imageEntry.mode, baseMode: baseEntry.mode })
      const transition = `${baseEntry.mode}->${imageEntry.mode}`
      modeTransitions[transition] = (modeTransitions[transition] ?? 0) + 1
    }
  }
  for (const [path, imageEntry] of imageByPath) {
    if (!baseByPath.has(path)) differences.push({ path, kind: 'added', image: imageEntry })
  }
  return { contentEqual: differences.length === 0, differences, modeDifferences, modeTransitions,
    imageEntries: image.length, baseEntries: base.length }
}

export function summarizeRawDiff(entries: RawDiffEntry[]): RawDiffSummary {
  const statuses: Record<string, number> = {}
  let contentChanges = 0
  for (const entry of entries) {
    const status = entry.status[0] ?? entry.status
    statuses[status] = (statuses[status] ?? 0) + 1
    // A raw `M` record can still be mode-only; only an object change means
    // content moved. Non-M statuses (A/D/T/...) always describe content.
    if (status !== 'M' || entry.oldObject !== entry.newObject) contentChanges++
  }
  return { entries: entries.length, contentChanges, statuses }
}

/** Bounded, path-naming description of a rejected comparison. */
export function describeSourceMismatch(input: { imageHead: string; datasetBase: string;
  comparison: SourceComparison; raw?: RawDiffSummary; limit?: number }): string {
  const limit = input.limit ?? 20
  const differences = input.comparison.differences.slice(0, limit).map(difference =>
    `${difference.kind}:${difference.path}`)
  return `imageHead=${input.imageHead}; datasetBase=${input.datasetBase}; ` +
    `contentDifferences=${input.comparison.differences.length}; ` +
    `contentSample=${JSON.stringify(differences)}; ` +
    `imageEntries=${input.comparison.imageEntries}; baseEntries=${input.comparison.baseEntries}; ` +
    `rawEntries=${input.raw?.entries ?? 'unavailable'}; rawContentChanges=${input.raw?.contentChanges ?? 'unavailable'}; ` +
    `rawStatuses=${JSON.stringify(input.raw?.statuses ?? {})}`
}
