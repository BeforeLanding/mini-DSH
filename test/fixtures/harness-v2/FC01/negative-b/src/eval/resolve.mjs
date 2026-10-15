import { directValue } from './direct.mjs'
import { neighbors } from '../graph/neighbors.mjs'
export const resolve = (name, settings) => directValue(settings, name) && neighbors(settings, name).length === 0
