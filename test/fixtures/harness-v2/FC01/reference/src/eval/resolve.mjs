import { directValue } from './direct.mjs'
import { neighbors } from '../graph/neighbors.mjs'
import { newPath } from '../graph/seen.mjs'
export function resolve(name, settings) {
  const path = newPath()
  const visit = current => {
    if (path.has(current)) throw new RangeError('dependency cycle')
    if (!directValue(settings, current)) return false
    path.add(current)
    const enabled = neighbors(settings, current).every(visit)
    path.delete(current)
    return enabled
  }
  return visit(name)
}
