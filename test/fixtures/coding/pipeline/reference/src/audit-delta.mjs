import { parseAudit } from './parse-audit.mjs'

// 与第 6 节的 diffPlan 同形：给出两版之间的「新出现的阻塞」与「不再阻塞的模块」。
// 上一版是第 10 节渲染出来的审计文本，本版是当前的计划对象，两侧都只看 blocked 的名字集合。
export function auditDelta(previousAuditText, plan) {
  const before = parseAudit(previousAuditText).blocked.map(entry => entry.name)
  const after = plan.blocked.map(entry => entry.name)
  return {
    newlyBlocked: after.filter(name => !before.includes(name)),
    unblocked: before.filter(name => !after.includes(name)),
  }
}
