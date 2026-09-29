import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveInside } from '../utils/path.js'

export interface ProjectContextLimits { maxFileBytes?: number; maxContentBytes?: number; maxDirectories?: number }
export interface ProjectRule { path: string; source: string; scope: string; bytes: number; content: string }
export interface ProjectContext { workspace: string; directory: string; rules: ProjectRule[]; contentBytes: number }
const defaults = { maxFileBytes: 16 * 1024, maxContentBytes: 32 * 1024, maxDirectories: 16 }
const relative = (workspace: string, filename: string) => path.relative(workspace, filename).replace(/\\/g, '/') || '.'
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT'

export class ProjectContextRuntime {
  readonly limits: Readonly<typeof defaults>
  readonly workspace: string
  constructor(workspace: string, limits: ProjectContextLimits = {}) {
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new Error('project context limits must be an object')
    for (const [key, value] of Object.entries(limits)) {
      if (!Object.hasOwn(defaults, key) || typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid project context limit: ${key}`)
    }
    this.workspace = path.resolve(workspace)
    this.limits = Object.freeze({ ...defaults, ...limits })
  }
  async #directories(directory: string) {
    const workspace = await fs.realpath(this.workspace)
    const cwd = await fs.realpath(resolveInside(workspace, directory))
    resolveInside(workspace, cwd)
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error('project context target must be a directory')
    const directories = [cwd]
    while (directories[0] !== workspace) {
      if (directories.length >= this.limits.maxDirectories) throw new Error('project context exceeds maxDirectories')
      directories.unshift(path.dirname(directories[0]))
    }
    return { workspace, cwd, directories }
  }
  async #read(workspace: string, filename: string) {
    try {
      const resolved = resolveInside(workspace, filename)
      const stat = await fs.stat(resolved)
      if (!stat.isFile()) throw new Error('not a regular file')
      if (stat.size > this.limits.maxFileBytes) throw new Error('exceeds maxFileBytes')
      const handle = await fs.open(resolved, 'r')
      try {
        const chunks: Buffer[] = []
        let bytes = 0
        while (true) {
          const chunk = Buffer.alloc(Math.min(64 * 1024, this.limits.maxFileBytes - bytes + 1))
          const { bytesRead } = await handle.read(chunk)
          if (!bytesRead) break
          bytes += bytesRead
          if (bytes > this.limits.maxFileBytes) throw new Error('exceeds maxFileBytes')
          chunks.push(chunk.subarray(0, bytesRead))
        }
        const content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
        return { content, bytes, source: relative(workspace, await fs.realpath(resolved)) }
      } finally { await handle.close() }
    } catch (error) {
      if (missing(error)) return undefined
      throw new Error(`project context ${relative(workspace, filename)}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }
  async load(directory = '.'): Promise<ProjectContext> {
    const { workspace, cwd, directories } = await this.#directories(directory)
    const rules: ProjectRule[] = []
    let contentBytes = 0
    for (const current of directories) {
      const filename = path.join(current, 'AGENTS.md')
      const loaded = await this.#read(workspace, filename)
      if (!loaded) continue
      contentBytes += loaded.bytes
      if (contentBytes > this.limits.maxContentBytes) throw new Error('project rules exceed maxContentBytes')
      rules.push({ path: relative(workspace, filename), scope: relative(workspace, current), ...loaded })
    }
    return { workspace, directory: relative(workspace, cwd), rules, contentBytes }
  }
}
