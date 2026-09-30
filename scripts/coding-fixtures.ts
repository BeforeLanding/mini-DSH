import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const fixtureIds = ['boundary', 'options', 'interface', 'normalize', 'dedupe', 'pagination', 'query', 'retry', 'merge'] as const
export type FixtureId = typeof fixtureIds[number]
const repository = fileURLToPath(new URL('../../', import.meta.url))
const fixtures = path.join(repository, 'test', 'fixtures', 'coding')
const sources: Record<FixtureId, string[]> = {
  boundary: ['src/index.mjs'], options: ['src/join.mjs'], interface: ['src/pricing.mjs', 'src/receipt.mjs'], merge: ['src/merge.mjs'], retry: ['src/retry.mjs'], query: ['src/query.mjs'], pagination: ['src/page.mjs'], dedupe: ['src/unique.mjs'], normalize: ['src/name.mjs'],
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
    const protectedFiles = await Promise.all(['package.json', 'check.mjs'].map(async filename => ({
      filename, content: await fs.readFile(path.join(source, 'initial', filename)),
    })))
    return {
      id, workspace, task, edits,
      async applyReference() {
        for (const edit of edits) await fs.writeFile(path.join(workspace, edit.path), edit.newText)
      },
      async evaluate({ timeoutMs = 10_000, maxOutputBytes = 32 * 1024 } = {}): Promise<Acceptance> {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new Error('invalid acceptance limits')
        const protectedFilesChanged: string[] = []
        for (const { filename, content } of protectedFiles) {
          try {
            const candidate = path.join(workspace, filename)
            if ((await fs.lstat(candidate)).isSymbolicLink() || !(await fs.readFile(candidate)).equals(content)) protectedFilesChanged.push(filename)
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
