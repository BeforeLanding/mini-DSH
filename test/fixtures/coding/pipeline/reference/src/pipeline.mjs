import { toBatches } from './batches.mjs'
import { findCycles } from './cycles.mjs'
import { topoOrder } from './order.mjs'
import { parseDeps } from './parse.mjs'

export function planPipeline(text) {
  const { records, external } = parseDeps(text)
  const cycles = findCycles(records)
  // 环成员交给 topoOrder 排除：它们排不出来，直接或间接依赖它们的模块也因此排不出来。
  const order = topoOrder(records, cycles.flat())
  return { records, external, cycles, order, batches: toBatches(order, records) }
}
