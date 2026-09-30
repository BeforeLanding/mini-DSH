import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const fixtureIds = ['boundary', 'options', 'interface', 'normalize', 'dedupe', 'pagination', 'query', 'retry', 'merge', 'csv', 'inventory', 'summary'] as const
export type FixtureId = typeof fixtureIds[number]
const repository = fileURLToPath(new URL('../../', import.meta.url))
const fixtures = path.join(repository, 'test', 'fixtures', 'coding')
// Cold-starting a Node process inside a freshly created temp workspace costs far more on
// Windows CI than the work itself: the same merge verification measured 120ms on Ubuntu
// but exceeded a 10s budget on windows-latest/Node22, while the next test on that machine
// finished a heavier flow in 1s. This budget bounds a hung candidate, not a performance
// target, so it keeps headroom for a cold start rather than tracking typical latency.
export const fixtureProcessTimeoutMs = 30_000
const sources: Record<FixtureId, string[]> = {
  boundary: ['src/index.mjs'], options: ['src/join.mjs'], interface: ['src/pricing.mjs', 'src/receipt.mjs'], summary: ['src/summary.mjs'], inventory: ['src/order.mjs', 'src/receipt.mjs'], csv: ['src/csv.mjs'], merge: ['src/merge.mjs', 'src/value.mjs'], retry: ['src/retry.mjs'], query: ['src/query.mjs'], pagination: ['src/page.mjs'], dedupe: ['src/unique.mjs'], normalize: ['src/name.mjs'],
}
async function protectedFilesIn(directory: string, editable: readonly string[], prefix = ''): Promise<{ filename: string; content: Buffer }[]> {
  const result: { filename: string; content: Buffer }[] = []
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const filename = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...await protectedFilesIn(directory, editable, filename))
    else if (entry.isFile() && !editable.includes(filename)) result.push({ filename, content: await fs.readFile(path.join(directory, filename)) })
    else if (!entry.isFile()) throw new Error(`invalid fixture initial entry: ${filename}`)
  }
  return result
}
export interface Acceptance {
  passed: boolean; exitCode: number | null; output: string; protectedFilesChanged: string[]
}
export async function createFixture(id: FixtureId) {
  if (!fixtureIds.includes(id)) throw new Error('unknown coding fixture')
  const source = path.join(fixtures, id)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `mini-dsh-fixture-${id}-`))
  const workspace = path.join(directory, 'workspace')
  try {
    await fs.cp(path.join(source, 'initial'), workspace, { recursive: true, errorOnExist: true })
    const task = await fs.readFile(path.join(source, 'TASK.md'), 'utf8')
    const edits = await Promise.all(sources[id].map(async filename => ({
      path: filename,
      oldText: await fs.readFile(path.join(source, 'initial', filename), 'utf8'),
      newText: await fs.readFile(path.join(source, 'reference', filename), 'utf8'),
    })))
    const protectedFiles = await protectedFilesIn(path.join(source, 'initial'), sources[id])
    return {
      id, workspace, task, edits,
      async applyReference() {
        for (const edit of edits) await fs.writeFile(path.join(workspace, edit.path), edit.newText)
      },
      async evaluate({ timeoutMs = fixtureProcessTimeoutMs, maxOutputBytes = 32 * 1024 } = {}): Promise<Acceptance> {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new Error('invalid acceptance limits')
        const protectedFilesChanged: string[] = []
        for (const { filename, content } of protectedFiles) {
          try {
            const candidate = path.join(workspace, filename)
            if (!(await fs.lstat(candidate)).isFile() || !(await fs.readFile(candidate)).equals(content)) protectedFilesChanged.push(filename)
          } catch { protectedFilesChanged.push(filename) }
        }
        const result = spawnSync(process.execPath, [path.join(source, 'verify.mjs'), workspace], {
          cwd: workspace, encoding: 'utf8', timeout: timeoutMs, maxBuffer: maxOutputBytes, windowsHide: true,
        })
        const output = Buffer.from([result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n')).subarray(0, maxOutputBytes).toString('utf8')
        const marker = `acceptance passed: ${id}`
        return { passed: result.status === 0 && !result.error && output.trim() === marker && !protectedFilesChanged.length,
          exitCode: result.status, output, protectedFilesChanged }
      },
      async close() {
        if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith(`mini-dsh-fixture-${id}-`)) throw new Error('invalid fixture cleanup path')
        await fs.rm(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (path.dirname(directory) !== path.resolve(os.tmpdir())) throw new Error('invalid fixture cleanup path', { cause: error })
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
}
