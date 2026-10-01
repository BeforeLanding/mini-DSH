# 14 审计增量

规格见 `docs/SPEC.md` 的第 14 节。

本阶段实现 `src/audit-delta.mjs` 的 `auditDelta(previousAuditText, plan)`：比较上一版审计文本与当前计划，返回 `{ newlyBlocked, unblocked }`。

要点：

- 上一版是第 10 节渲染出来的**文本**，用第 11 节的 `parseAudit` 解析；本版直接是计划对象，用它的 `blocked`。两处都直接用，不要重写。
- `newlyBlocked`：本版阻塞、上版不阻塞的模块，按**本版** `blocked` 的顺序。
- `unblocked`：上版阻塞、本版不阻塞的模块，按**上版** `blocked` 的顺序。
- 形状与第 5 节的 `diffPlan` 一致：只比较集合，顺序各自跟随自己那一侧。

完成后运行 `node check.mjs 14`，它会跑全部十四个阶段的检查。
