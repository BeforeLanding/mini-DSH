import type { GroupBudgetEvent, GroupJournal } from '../core/task-group-budget.js'
import type { OrchestrationStore } from './store.js'

// 根预算组的持久化落在编排日志里：与 M0 的 SessionGroupJournal 用同一套 group/* 状态机，
// 区别只在落点。协调器本身不知道日志写到哪里。
export class OrchestrationGroupJournal implements GroupJournal {
  constructor(readonly store: OrchestrationStore) {}
  read(): readonly GroupBudgetEvent[] {
    return this.store.events().flatMap(event => event.type.startsWith('group/')
      ? [{ type: event.type, data: event.data } as GroupBudgetEvent]
      : [])
  }
  async append(event: GroupBudgetEvent) { await appendGroupEvent(this.store, event) }
}

// GroupBudgetEvent 的 type/data 对与 OrchEventData 的 group/* 条目一一对应；
// 这个 switch 让编译器逐支收窄，避免把联合类型整体断言成泛型参数。
export function appendGroupEvent(store: OrchestrationStore, event: GroupBudgetEvent) {
  switch (event.type) {
    case 'group/start': return store.append('group/start', event.data)
    case 'group/budget-reserved': return store.append('group/budget-reserved', event.data)
    case 'group/model-dispatched': return store.append('group/model-dispatched', event.data)
    case 'group/reservation-released': return store.append('group/reservation-released', event.data)
    case 'group/usage-unknown': return store.append('group/usage-unknown', event.data)
    case 'group/budget-settled': return store.append('group/budget-settled', event.data)
    case 'group/tool-admitted': return store.append('group/tool-admitted', event.data)
  }
}
