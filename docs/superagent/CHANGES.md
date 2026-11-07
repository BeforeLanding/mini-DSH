# 多 Agent 编排改动与证据

## M1-② 编排存储、状态折叠与根账本日志（2026-11-07）

**改动**

- 新增 `src/orchestration/contracts.ts`：根任务、计划、attempt、整合、验收、人工请求与 `group/*` 预算事件的日志信封。
- 新增 `src/orchestration/validation.ts`：事件信封/负载运行时校验、计划结构校验、日志解码；未知类型与未知版本拒绝。
- 新增 `src/orchestration/store.ts`：`OrchestrationStore`（`writer.lock`、逐条 fsync、`seq` 严格递增、尾部半行拒绝与 `quarantineTail`）。
- 新增 `src/orchestration/state.ts`：`foldOrchestration` 纯函数、合法迁移检查、根任务终态约束、按来源统计的账目。
- 新增 `src/orchestration/group-journal.ts`：`OrchestrationGroupJournal` 把 M0 协调器的 `group/*` 事件写入编排日志。
- 新增 `docs/superagent/{REQUIREMENTS,DECISIONS,TASKS,CHANGES}.md`，记录 D8 审批策略与本里程碑实现决策。

**验证**

```text
pnpm typecheck                 # 通过
pnpm build                     # 通过
node --test dist/test/orchestration-store.test.js dist/test/orchestration-state.test.js dist/test/orchestration-ledger.test.js
# tests 14 / pass 14 / fail 0
```

**测试覆盖**

- 存储：落盘与重开续号、第二个写入者被拒、非法负载不落盘且不封存、并发追加序号唯一、半行拒绝与显式隔离。
- 状态：完整单 attempt 生命周期、非法迁移、迟到结果、`group/*` 账目与来源统计、`completed`/`partial` 终态约束、混合根任务与未知事件。
- 账本：预留-派发-结算写入编排日志、重开时释放未派发预留并把已派发转未知、并发准入不超额、注入时钟的 wall 截止。

**未包含**

- 审批队列（M2）；未来日志版本的只读兼容（M3）；git/worktree 与 worker 执行（M1-③/④）。
