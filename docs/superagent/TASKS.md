# 多 Agent 编排任务清单

状态以实际代码、测试与提交为准；契约见 [DEVELOPMENT.md](DEVELOPMENT.md)，证据见 [CHANGES.md](CHANGES.md)。

## M0：移植方案 A（已完成）

- [x] ① 中性哈希/有界读取 + 只读角色与 `allowedTools` — `e9b8a8e`
- [x] ② 任务组预算（派发钩子与 run guard） — `f9b7adf`
- [x] ③ 批次委派与不重跑恢复 — `d20abeb`、`0dfe548`
- [x] ④ reviewer 候选版本 — `bf20603`
- [x] ⑤ CLI 开关、`demo:team` 与文档同步 — `db85fe6`

## M1：最小纵向闭环（进行中）

- [x] ① `GroupJournal` 抽象（A 的行为与测试不变） — `cfbc09f`
- [x] ② 编排存储、状态折叠与 `OrchestrationGroupJournal`
  - 验收：日志逐条落盘、单写入者锁、半行拒绝与显式隔离；状态折叠拒绝非法迁移；根预算事件写入编排日志并可恢复。
  - 证据：`test/orchestration-store.test.ts`、`test/orchestration-state.test.ts`、`test/orchestration-ledger.test.ts`。
- [x] ③ git/worktree 管理
  - 验收：脏工作树拒绝；base 快照与 attempt/integration worktree 创建、分支命名、prepare、清理；真实 git 临时仓库测试。
  - 证据：`src/orchestration/git.ts`、`src/orchestration/worktrees.ts`、`test/orchestration-git.test.ts`。
- [x] ④ 单 attempt 编排 + CLI + inspect
  - 验收：离线端到端通过；整合分支存在且验收命令 exit 0；用户工作树前后一致；会话日志可被现有 `inspect` 读取。
  - 证据：`src/orchestration/{worker,integrator,verifier,orchestrator,inspect}.ts`、`src/app/orchestrate-cli.ts`、`test/orchestration-e2e.test.ts`、`test/orchestration-worker.test.ts`、`test/orchestration-integrator.test.ts`。
  - M1 边界：只执行一个子任务、只接受计划文件（planner 与并行波次属 M2）；`resume`/`list` 之外的恢复与冲突处置属 M3/M2。

## M2：并行与整合（进行中）

- [x] ① 计划校验与判定
  - 验收：DAG 环、同波次写集相交、保护路径与验收命令形状被拒绝；跨波次重叠允许；`single`/`parallel` 判定稳定。
  - 证据：`src/orchestration/plan.ts`、`test/orchestration-plan.test.ts`。
- [ ] ② 只读 planner（基线快照、一次纠正重试）
- [ ] ③ 审批 FIFO 队列（策略、显示计时、取消与关闭）
- [ ] ④ 并行波次调度（并发池、依赖基线、波次预算）
- [ ] ⑤ 多 attempt 整合与冲突处置（`rerun-serially`/`skip-subtask`/`abort`）

## M3–M4：待开始

- [ ] M3 失败、取消与恢复（故障注入、停止语义、账本恢复与 429 冷却）
- [ ] M4 评测、演示与文档（组合 fixture、演示脚本、四臂对照离线装配；付费批次需单独授权）
