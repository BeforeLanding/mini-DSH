import fs from 'node:fs'
import path from 'node:path'

export function isInside(workspace: string, target: string) {
  const relative = path.relative(path.resolve(workspace), path.resolve(target))
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function realpathWithMissing(target: string): string {
  const missing: string[] = []
  let current = target
  while (true) {
    // Match fs.promises.realpath: native resolution also expands Windows 8.3 aliases.
    try { return path.join(fs.realpathSync.native(current), ...missing) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('path escapes the workspace through a symlink') }
      catch (statError) { if (!(statError instanceof Error && 'code' in statError && statError.code === 'ENOENT')) throw statError }
      const parent = path.dirname(current)
      if (parent === current) throw error
      missing.unshift(path.basename(current))
      current = parent
    }
  }
}

export function resolveInside(workspace: string, requested: unknown) {
  if (typeof requested !== 'string') throw new Error('path must be a string')
  const root = path.resolve(workspace)
  const target = path.resolve(root, requested)
  if (!isInside(root, target)) throw new Error('path escapes the workspace')
  if (!isInside(realpathWithMissing(root), realpathWithMissing(target))) {
    throw new Error('path escapes the workspace through a symlink')
  }
  return target
}
