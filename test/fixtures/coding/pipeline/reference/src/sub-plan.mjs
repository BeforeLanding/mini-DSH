import { blockReasons } from './blocked.mjs'
import { toBatches } from './batches.mjs'
import { closure } from './closure.mjs'
import { findCycles } from './cycles.mjs'
import { topoOrder } from './order.mjs'

// 子计划：只保留 names 及其传递依赖。取闭包而不是「只留 names」的理由是闭包对依赖向下封闭——留下的
// 每个模块的依赖也都在里面，因此过滤不会让任何模块凭空丢掉依赖，环也整条保留。
//
// 留下的 records 拿去按第 2～4、9 节**重算**，而不是把原来的 order/batches 过滤一遍：过滤出来的批次
// 会跳号（中间整批被删掉），重算才不会，而且重算让「子计划仍然是一份合法的计划」这件事自动成立。
export function subPlan(plan, names) {
  const kept = new Set(closure(plan.records, names))
  const records = plan.records
    .filter(record => kept.has(record.name))
    .map(record => ({ name: record.name, deps: [...record.deps] }))
  const cycles = findCycles(records)
  const order = topoOrder(records, cycles.flat())
  // 闭包保住了全部本文件内的依赖，所以「依赖不在 kept 里」等价于「它是外部名」。
  const external = []
  for (const record of records) for (const dep of record.deps) if (!kept.has(dep) && !external.includes(dep)) external.push(dep)
  return { records, external, cycles, order, batches: toBatches(order, records), blocked: blockReasons(records, cycles) }
}
