import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readTaskSequence } from './coding-fixtures.js'
import type { FixtureKind } from './coding-fixtures.js'
import type { V2IsolationConfig } from './eval-v2-isolation.js'
import { createIsolatedCommandRunner } from './eval-v2-isolation.js'

export const harnessV2Ids = ['U01', 'U02', 'U03', 'U04', 'B01', 'B02', 'B03', 'B04', 'F01', 'F02', 'F03', 'F04', 'R01', 'R02', 'R03', 'R04', 'T01', 'T02', 'T03', 'T04', 'UC01', 'BC01', 'FC01', 'RC01', 'TC01'] as const
export type HarnessV2Id = typeof harnessV2Ids[number]
export const harnessV2Root = fileURLToPath(new URL('../../test/fixtures/harness-v2/', import.meta.url))

export interface V2ContractGroup { name: string; passed: boolean; detail?: string }
interface V2Meta { kind: FixtureKind; editable: string[]; artifact?: string; groups: [string, string, string, string]; stages?: 4 }
interface V2Acceptance { passed: boolean; exitCode: number | null; output: string; protectedFilesChanged: string[]; groups: V2ContractGroup[] }

const under = (root: string, relative: string): string => {
  if (!relative || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '..' || part === '.')) throw new Error(`invalid V2 fixture path: ${relative}`)
  return path.join(root, relative)
}
const exists = (target: string) => fs.stat(target).then(() => true, () => false)

async function regularFiles(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = []
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...await regularFiles(root, name))
    else if (entry.isFile()) result.push(name)
    else throw new Error(`invalid V2 fixture entry: ${name}`)
  }
  return result.sort()
}

function validMeta(value: unknown): value is V2Meta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const meta = value as Record<string, unknown>
  return (meta.kind === 'edit' || meta.kind === 'repro' || meta.kind === 'mutation')
    && Array.isArray(meta.editable) && meta.editable.every(file => typeof file === 'string')
    && (meta.artifact === undefined || typeof meta.artifact === 'string')
    && Array.isArray(meta.groups) && meta.groups.length === 4
    && meta.groups.every(name => typeof name === 'string' && name.length > 0)
    && new Set(meta.groups).size === 4
    && (meta.stages === undefined || meta.stages === 4)
}

export async function createV2Fixture(id: HarnessV2Id, isolation?: Omit<V2IsolationConfig, 'workspace'>) {
  if (!harnessV2Ids.includes(id)) throw new Error(`unknown V2 fixture: ${id}`)
  const source = path.join(harnessV2Root, id)
  const meta: unknown = JSON.parse(await fs.readFile(path.join(source, 'meta.json'), 'utf8'))
  if (!validMeta(meta)) throw new Error(`invalid V2 fixture metadata: ${id}`)
  for (const file of meta.editable) under(source, file)
  if (meta.artifact) under(source, meta.artifact)
  if (meta.kind === 'edit' ? meta.artifact !== undefined : !meta.artifact || meta.editable.length > 0) throw new Error(`invalid V2 fixture kind contract: ${id}`)
  const initial = path.join(source, 'initial'), reference = path.join(source, 'reference')
  const initialFiles = await regularFiles(initial)
  if (meta.editable.some(file => !initialFiles.includes(file))) throw new Error(`V2 editable file missing from initial: ${id}`)
  const protectedFiles = await Promise.all(initialFiles.filter(file => !meta.editable.includes(file)).map(async file => ({ path: file, bytes: await fs.readFile(under(initial, file)) })))
  const edits = await Promise.all(meta.editable.map(async file => ({ path: file, oldText: await fs.readFile(under(initial, file), 'utf8'), newText: await fs.readFile(under(reference, file), 'utf8') })))
  const artifact = meta.artifact ? { path: meta.artifact, content: await fs.readFile(under(source, `oracle/${meta.artifact}`), 'utf8') } : undefined
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `mini-dsh-v2-${id}-`))
  const workspace = path.join(directory, 'workspace')
  try {
    await fs.cp(initial, workspace, { recursive: true, errorOnExist: true })
    const tasks = await readTaskSequence(source)
    if (tasks.length !== (meta.stages ?? 1)) throw new Error(`V2 task stage count mismatch: ${id}`)
    const overlay = async (folder: string) => {
      for (const file of await regularFiles(folder)) {
        const target = under(workspace, file)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.copyFile(under(folder, file), target)
      }
    }
    return {
      id, kind: meta.kind, workspace, tasks, edits, artifact,
      async applyReference() {
        for (const edit of edits) await fs.writeFile(under(workspace, edit.path), edit.newText)
        if (artifact) await fs.writeFile(under(workspace, artifact.path), artifact.content)
      },
      async applyCounterexample(name: 'negative-a' | 'negative-b') {
        await this.applyReference()
        await overlay(path.join(source, name))
      },
      async applyStageReference(index: number) {
        if (meta.stages !== 4 || !Number.isInteger(index) || index < 1 || index > 4) throw new Error(`V2 fixture has no stage ${index}`)
        await overlay(path.join(source, 'reference-stages', String(index).padStart(2, '0')))
      },
      async verifyStageReference(index: number): Promise<boolean> {
        if (!isolation || meta.stages !== 4 || !Number.isInteger(index) || index < 1 || index > 4) throw new Error(`V2 stage ${index} cannot be verified`)
        const runner = createIsolatedCommandRunner({ ...isolation, workspace })
        const result = await runner({ executable: 'ignored', args: [], command: `node check-stage-${String(index).padStart(2, '0')}.mjs`, cwd: workspace, signal: new AbortController().signal, timeoutMs: 10_000 })
        return result.status === 'exited' && result.exitCode === 0
      },
      async evaluateAt(candidate: string): Promise<V2Acceptance> {
        if (!isolation) throw new Error('V2 hidden acceptance requires Linux isolation for candidate code')
        const protectedFilesChanged: string[] = []
        for (const expected of protectedFiles) {
          try {
            const target = under(candidate, expected.path)
            if (!(await fs.lstat(target)).isFile() || !(await fs.readFile(target)).equals(expected.bytes)) protectedFilesChanged.push(expected.path)
          } catch { protectedFilesChanged.push(expected.path) }
        }
        const report = path.join(directory, `groups-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
        const result = spawnSync(process.execPath, [path.join(source, 'verify.mjs'), candidate, report], {
          cwd: candidate, timeout: 30_000, maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true,
          env: { ...process.env, V2_RUNTIME_ROOT: isolation.runtimeRoot, V2_DISTRO: isolation.distro },
        })
        let groups: V2ContractGroup[] = []
        try {
          const parsed: unknown = JSON.parse(await fs.readFile(report, 'utf8'))
          if (Array.isArray(parsed) && parsed.length === 4 && parsed.every(entry => entry && typeof entry === 'object' && typeof entry.name === 'string' && typeof entry.passed === 'boolean')) groups = parsed
        } catch { /* Missing or invalid verifier output is an acceptance failure. */ }
        await fs.rm(report, { force: true })
        const namesMatch = groups.every((group, index) => group.name === meta.groups[index])
        const passed = result.status === 0 && !result.error && groups.length === 4 && namesMatch && groups.every(group => group.passed) && !protectedFilesChanged.length
        return { passed, exitCode: result.status, output: [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 32 * 1024), protectedFilesChanged, groups }
      },
      async evaluate(): Promise<V2Acceptance> { return this.evaluateAt(workspace) },
      async close() {
        if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith(`mini-dsh-v2-${id}-`)) throw new Error('invalid V2 fixture cleanup path')
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      },
    }
  } catch (error) {
    if (await exists(directory)) await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    throw error
  }
}
