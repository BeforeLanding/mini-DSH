import { blockReasons } from './blocked.mjs'
import { toBatches } from './batches.mjs'
import { findCycles } from './cycles.mjs'
import { topoOrder } from './order.mjs'
import { parseDeps } from './parse.mjs'

export function planPipeline(text) {
  const { records, external } = parseDeps(text)
  const cycles = findCycles(records)
  // 环成员交给 topoOrder 排除：它们排不出来，直接或间接依赖它们的模块也因此排不出来。
  const order = topoOrder(records, cycles.flat())
  // blocked 是 order 的补集，逐项给出原因；它不改变 order 的取值，只是把「为什么没排出来」写下来。
  return { records, external, cycles, order, batches: toBatches(order, records), blocked: blockReasons(records, cycles) }
}
