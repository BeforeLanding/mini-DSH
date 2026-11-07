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

## M2：并行与整合（已完成）

- [x] ① 计划校验与判定
  - 验收：DAG 环、同波次写集相交、保护路径与验收命令形状被拒绝；跨波次重叠允许；`single`/`parallel` 判定稳定。
  - 证据：`src/orchestration/plan.ts`、`test/orchestration-plan.test.ts`。
- [x] ② 只读 planner（基线快照、一次纠正重试）
  - 验收：`planner` 角色只有读工具；脚本模型首次无效、第二次有效时得到计划；连续两次无效明确失败；会话日志可被现有 `inspect` 读取。
  - 证据：`src/core/agent-capabilities.ts`、`src/orchestration/planner.ts`、`test/orchestration-planner.test.ts`、`test/agent-capabilities.test.ts`。
- [x] ③ 审批 FIFO 队列（策略、显示计时、取消与关闭）
  - 验收：不同时显示两条；写入按 D8 自动批准、Bash 询问；超时从显示时开始；取消 attempt 与关闭通道立即拒绝；审批审计事件落编排日志。
  - 证据：`src/orchestration/approval-broker.ts`、`test/orchestration-approval.test.ts`、`src/orchestration/{contracts,validation,state,inspect,orchestrator}.ts`。
- [x] ④ 并行波次调度（并发池、依赖基线、波次预算）
  - 验收：三子任务组合计划中两个 worker 的 started/finished 区间重叠，第三个在第二波次以整合 head 为基线执行；`single` 模式逐个执行；没有计划文件时 planner 可替代；波次预算按根余额切分；在途上限生效。
  - 证据：`src/orchestration/{orchestrator,planner,integrator,worktrees,git,state}.ts`、`src/core/task-group-budget.ts`、`test/orchestration-e2e.test.ts`、`test/orchestration-ledger.test.ts`。
- [x] ⑤ 多 attempt 整合与冲突处置（`rerun-serially`/`skip-subtask`/`abort`）
  - 验收：人为构造的文件/目录冲突产生 `human.request(conflict)`；跳过冲突子任务得到 `partial`；中止得到 `cancelled` 且整合现场保留；`rerun-serially` 在整合 head 上新建 attempt；无决定时停在 `needs_human`。
  - 证据：`src/orchestration/{orchestrator,state,integrator}.ts`、`src/app/orchestrate-cli.ts`、`test/orchestration-e2e.test.ts`、`test/orchestration-worker.test.ts`。

## M3：失败、取消与恢复（进行中）

- [x] ① 状态折叠的迟到/过期/重复规则
  - 验收：`attempt/late` 只接受已终结 attempt，旧 epoch 只记录不改变状态；`attempt/finished` 保留 `unknownSideEffects`，`group/usage-unknown` 保留 `cause`。
  - 证据：`test/orchestration-state.test.ts`、`test/task-group-budget.test.ts`。
- [x] ② 停止语义（两级 Ctrl-C 与 wall 截止）
  - 验收：第一次 Ctrl-C 只停止派发，未启动 attempt 记 `skipped`，运行中的继续并整合/验收；第二次 Ctrl-C 与 wall 截止中止运行中 run，attempt 记 `cancelled`，不整合，根任务 `cancelled`。
  - 证据：`src/orchestration/orchestrator.ts`、`src/app/orchestrate-cli.ts`、`test/orchestration-stop.test.ts`。
- [ ] ③ attempt 与整合恢复（故障注入与 `resume`）
- [x] ④ 账本恢复与 429 冷却
  - 验收：崩溃留下的 `dispatched` 预留转为 `unknown(cause=crash)`；取消产生的未知不阻断后续派发；人工确认后可继续；429 释放预留并让同组下一次派发等待共享冷却。
  - 证据：`src/core/task-group-budget.ts`、`test/orchestration-ledger.test.ts`、`test/task-group-budget.test.ts`。
- [ ] ⑤ 崩溃演示脚本

## M4：待开始

- [ ] M4 评测、演示与文档（组合 fixture、演示脚本、四臂对照离线装配；付费批次需单独授权）
