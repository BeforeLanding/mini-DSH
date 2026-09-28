import fs from 'node:fs'
import path from 'node:path'

export function isInside(workspace, target) {
  const relative = path.relative(path.resolve(workspace), path.resolve(target))
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function realpathWithMissing(target) {
  const missing = []
  let current = target
  while (true) {
    try { return path.join(fs.realpathSync(current), ...missing) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      // A dangling symlink is an existing prefix with an unsafe destination.
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('path escapes the workspace through a symlink') }
      catch (statError) { if (statError.code !== 'ENOENT') throw statError }
      const parent = path.dirname(current)
      if (parent === current) throw error
      missing.unshift(path.basename(current))
      current = parent
    }
  }
}

export function resolveInside(workspace, requested) {
  if (typeof requested !== 'string') throw new Error('path must be a string')
  const root = path.resolve(workspace)
  const target = path.resolve(root, requested)
  if (!isInside(root, target)) throw new Error('path escapes the workspace')
  if (!isInside(realpathWithMissing(root), realpathWithMissing(target))) {
    throw new Error('path escapes the workspace through a symlink')
  }
  return target
}
