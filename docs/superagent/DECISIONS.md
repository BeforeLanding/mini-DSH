# 多 Agent 编排实现决策

**非规范性说明：** 方向性决策与数值以 [DEVELOPMENT.md](DEVELOPMENT.md) §2.8 为准；本文件记录开发过程中落实这些决策的具体选择、代码锚点与测试锚点，避免把实现事实只留在提交信息里。

## D8 编排模式的审批策略（用户已确认，2026-11-06）

- **决定：** `orchestrate` 模式下，worktree 内的 `write_file` / `edit_file` 默认自动批准；Bash 默认仍需人工批准，所有请求经单一 FIFO 队列逐条显示；`--approve-writes ask` 可恢复逐条审批。单 Agent CLI 的审批行为不变。
- **理由：** worktree 内写入不触及用户工作树、可整体丢弃，且 attempt 结束后仍有写集检查；Bash 可越出 worktree，不能自动批准。
- **代码锚点（拟）：** `src/orchestration/approval-broker.ts`（M2）、`src/orchestration/worker.ts` 的 `autoApprove: false` 与 `sandbox.setApprover`。
- **测试锚点（拟）：** `test/orchestration-approval.test.ts`（M2）。
- **状态：** 策略已确认；编排入口尚未实现审批队列，M2 落地时必须同时更新本文件与需求记录。

## M1-② 编排日志与根账本落点

- **决定：** 编排日志使用独立目录与独立信封 `{v, rootId, seq, id, at, type, data}`；`src/core/` 不新增编排逻辑，`EventData` 会话契约不变。
- **决定：** 根预算组复用 M0 的 `TaskGroupBudgetCoordinator`，通过 `GroupJournal` 写入编排日志；不新建第二套预留/结算状态机。
- **决定：** 状态折叠 `foldOrchestration` 是纯函数，遇到非法迁移即拒绝；`completed` 根任务必须已整合全部子任务且验收证据全部通过，`partial` 必须已有整合且已整合部分验收通过。
- **决定：** 编排日志当前严格只读 `v: 1`；未来版本只读兼容与 `resume` 拒绝规则留到 M3 恢复流程实现，不提前宣称支持。
- **决定：** `approval/requested` / `approval/resolved` 审计事件随 M2 审批队列一起追加；事件类型只追加，不修改已有类型。
- **代码锚点：** `src/orchestration/contracts.ts`、`validation.ts`、`store.ts`、`state.ts`、`group-journal.ts`。
- **测试锚点：** `test/orchestration-store.test.ts`、`test/orchestration-state.test.ts`、`test/orchestration-ledger.test.ts`。
