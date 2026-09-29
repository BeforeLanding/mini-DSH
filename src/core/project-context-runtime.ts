import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveInside } from '../utils/path.js'

export interface ProjectContextLimits { maxFileBytes?: number; maxContentBytes?: number; maxDirectories?: number }
export interface ProjectRule { path: string; source: string; scope: string; bytes: number; content: string }
export interface ProjectMetadata {
  repositoryRoot: string | null
  package?: { path: string; source: string; packageManager?: string; node?: string; scripts: Record<string, string> }
  markers: { path: string; kind: string }[]
  notices: string[]
}
export interface ProjectContext { workspace: string; directory: string; rules: ProjectRule[]; contentBytes: number; metadata: ProjectMetadata }
const defaults = { maxFileBytes: 16 * 1024, maxContentBytes: 32 * 1024, maxDirectories: 16 }
const relative = (workspace: string, filename: string) => path.relative(workspace, filename).replace(/\\/g, '/') || '.'
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT'
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

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
  async #metadata(workspace: string, directories: string[]): Promise<ProjectMetadata> {
    const metadata: ProjectMetadata = { repositoryRoot: null, markers: [], notices: [] }
    const seen = new Set<string>()
    let packageSelected = false
    for (const current of [...directories].reverse()) {
      const packagePath = path.join(current, 'package.json')
      if (!packageSelected) {
        try {
          const loaded = await this.#read(workspace, packagePath)
          if (loaded) {
            packageSelected = true
            const value: unknown = JSON.parse(loaded.content)
            if (!record(value)) throw new Error('package.json must be an object')
            const scripts: Record<string, string> = {}
            if (value.scripts !== undefined && !record(value.scripts)) metadata.notices.push(`${relative(workspace, packagePath)}: invalid scripts object`)
            if (record(value.scripts)) for (const name of ['test', 'check', 'typecheck', 'lint', 'build']) {
              if (typeof value.scripts[name] === 'string') scripts[name] = value.scripts[name]
              else if (value.scripts[name] !== undefined) metadata.notices.push(`${relative(workspace, packagePath)}: invalid ${name} script`)
            }
            metadata.package = { path: relative(workspace, packagePath), source: loaded.source, scripts,
              ...(typeof value.packageManager === 'string' ? { packageManager: value.packageManager } : {}),
              ...(record(value.engines) && typeof value.engines.node === 'string' ? { node: value.engines.node } : {}),
            }
          }
        } catch (error) {
          packageSelected = true
          const reason = error instanceof SyntaxError ? 'invalid JSON' : error instanceof Error && error.message.includes('maxFileBytes') ? 'exceeds maxFileBytes' : 'unavailable or invalid configuration'
          metadata.notices.push(`${relative(workspace, packagePath)}: ${reason}; no parent package substituted`)
        }
      }
      const markers = [['.git', 'git'], ['tsconfig.json', 'typescript'], ['pnpm-lock.yaml', 'pnpm-lock'], ['package-lock.json', 'npm-lock'], ['yarn.lock', 'yarn-lock'], ['README.md', 'readme']]
      for (const [filename, kind] of markers) {
        if (seen.has(kind)) continue
        const target = path.join(current, filename)
        try {
          const resolved = resolveInside(workspace, target)
          const stat = kind === 'git' ? await fs.lstat(resolved) : await fs.stat(resolved)
          if (kind === 'git' ? !stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()) : stat.isFile()) {
            seen.add(kind)
            if (kind === 'git') metadata.repositoryRoot = relative(workspace, current)
            else metadata.markers.push({ path: relative(workspace, target), kind })
          }
        } catch (error) {
          if (!missing(error)) metadata.notices.push(`${relative(workspace, target)}: marker unavailable`)
        }
      }
    }
    return metadata
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
    let metadata = await this.#metadata(workspace, directories)
    const metadataBytes = Buffer.byteLength(JSON.stringify(metadata))
    if (contentBytes + metadataBytes > this.limits.maxContentBytes) {
      metadata = { repositoryRoot: null, markers: [], notices: ['project metadata omitted: exceeds remaining maxContentBytes'] }
    } else contentBytes += metadataBytes
    return { workspace, directory: relative(workspace, cwd), rules, contentBytes, metadata }
  }
}
