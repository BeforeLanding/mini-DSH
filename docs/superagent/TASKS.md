# 多 Agent 编排任务清单

状态以实际代码、测试与提交为准；契约见 [DEVELOPMENT.md](DEVELOPMENT.md)，证据见 [CHANGES.md](CHANGES.md)。

## M0：移植方案 A（已完成）

- [x] ① 中性哈希/有界读取 + 只读角色与 `allowedTools` — `e9b8a8e`
- [x] ② 任务组预算（派发钩子与 run guard） — `f9b7adf`
- [x] ③ 批次委派与不重跑恢复 — `d20abeb`、`0dfe548`
- [x] ④ reviewer 候选版本 — `bf20603`
- [x] ⑤ CLI 开关、`demo:team` 与文档同步 — `db85fe6`

## M1：最小纵向闭环（已完成）

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

## M3：失败、取消与恢复（已完成）

- [x] ① 状态折叠的迟到/过期/重复规则
  - 验收：`attempt/late` 只接受已终结 attempt，旧 epoch 只记录不改变状态；`attempt/finished` 保留 `unknownSideEffects`，`group/usage-unknown` 保留 `cause`。
  - 证据：`test/orchestration-state.test.ts`、`test/task-group-budget.test.ts`。
- [x] ② 停止语义（两级 Ctrl-C 与 wall 截止）
  - 验收：第一次 Ctrl-C 只停止派发，未启动 attempt 记 `skipped`，运行中的继续并整合/验收；第二次 Ctrl-C 与 wall 截止中止运行中 run，attempt 记 `cancelled`，不整合，根任务 `cancelled`。
  - 证据：`src/orchestration/orchestrator.ts`、`src/app/orchestrate-cli.ts`、`test/orchestration-stop.test.ts`。
- [x] ③ attempt 与整合恢复（故障注入与 `resume`）
  - 验收：已完成 run 被采用且 provider 调用数不增加；中断且有未知副作用的 attempt 产生人工请求；`resume --retry/--skip` 可处理；integ 中途崩溃按记录的基线重放；验收只在缺失证据时重跑；尾部半行拒绝恢复。
  - 证据：`src/orchestration/{faults,recovery,orchestrator}.ts`、`src/app/orchestrate-cli.ts`、`test/orchestration-recovery.test.ts`。
- [x] ④ 账本恢复与 429 冷却
  - 验收：崩溃留下的 `dispatched` 预留转为 `unknown(cause=crash)`；取消产生的未知不阻断后续派发；人工确认后可继续；429 释放预留并让同组下一次派发等待共享冷却。
  - 证据：`src/core/task-group-budget.ts`、`test/orchestration-ledger.test.ts`、`test/task-group-budget.test.ts`。
- [x] ⑤ 崩溃演示脚本
  - 验收：`pnpm demo:orchestrate-crash` 离线通过；演示崩溃前已完成 run 被采用、未知用量需确认、未知副作用需人工决定，最终恢复为 `completed`。
  - 证据：`scripts/demo-orchestrate-crash.ts`、`package.json`。
  - 命令：`pnpm demo:orchestrate-crash`。

## M4：评测、演示与文档（离线部分已完成）

- [x] ① 组合 fixture 与验收器
  - 验收：初始态被隐藏验收器拒绝、参考态通过；`parallel-composite` 分层为两波次；隐藏验收器不在工作区；计划验收命令使用工作区内相对路径。
  - 证据：`scripts/orchestration-fixtures.ts`、`test/fixtures/orchestration/`、`test/orchestration-fixtures.test.ts`。
- [x] ② 演示脚本（`demo:orchestrate-single` / `demo:orchestrate-parallel`）
  - 验收：单任务演示由 planner 判定 `single`；并行演示第一波区间重叠、第二波依赖整合结果；演示以隐藏验收器为最终结论，用户工作树不变。
  - 证据：`scripts/demo-orchestrate.ts`、`package.json`。
- [x] ③ 评测执行器（离线装配与 `--validate-only`）
  - 验收：四臂矩阵与公平性断言在零 provider 请求下通过；隐藏验收器正反例通过；`--execute` 明确拒绝。
  - 证据：`scripts/eval-orchestrate.ts`、`test/eval-orchestrate.test.ts`、`package.json`。
- [x] ④ 文档与里程碑收尾
  - 验收：README、REQUIREMENTS、TASKS、CHANGES、DECISIONS 与 PROGRESS 同步；全量 `pnpm check` / `pnpm test` / `pnpm lint` 通过。
  - 证据：本目录文档与 README；命令见 [CHANGES.md](CHANGES.md) 的 M4-④。
- [ ] ⑤ 付费小批次（需单独授权；未授权时交付只含离线证据）——**进行中：零付费准备**（2026-11-08 起）
  - 已定：R/R-serial 用夹具固定计划（不评测 planner）；每 run 1M tokens / 96 requests / 192 tool calls / 30 min，四臂相同；模型 `deepseek/deepseek-flash`；2 夹具 × 4 臂 × 2 重复 = 16 runs；D′、冲突型、负对照仍未装配。
  - [x] ⑤-1 批次 manifest、成本上限与 `--plan-only`
    - 验收：manifest 冻结 git commit、价格快照、模型与矩阵 digest，`wx` 不覆盖；上限按每 run `1M × 最高单价 × 1.2 + 满额末请求` × 16 + 探测预留计算；provider 请求 0。
    - 证据：`scripts/eval-orchestrate-batch.ts`、`scripts/eval-orchestrate.ts`、`test/eval-orchestrate-batch.test.ts`；命令见 CHANGES 的 M4-⑤-1。
  - [x] ⑤-2 四臂执行器、并发安全金额守卫、按 worktree 的隔离包装与 `--rehearse`
    - 验收：守卫计入在途预留，两个并发请求不能合计越过上限；缺 provider usage 后全部拒发；`--rehearse` 以脚本模型跑完 16 runs、隐藏验收全过、provider 请求 0。
    - 证据：`scripts/eval-orchestrate-arms.ts`、`scripts/eval-orchestrate-run.ts`、`test/eval-orchestrate-arms.test.ts`（提交 `570bcd5`）；命令见 CHANGES 的 M4-⑤-2。
  - [ ] ⑤-3 `--execute` 闸门、协议探测、停批规则与报告
    - 验收：缺参、已存在的证据目录、脏树或 HEAD 与 manifest 不符均拒绝；未知用量、基础设施错误、金额无法预留时立即停批；全部用脚本模型测试。
  - [ ] ⑤-4 文档与授权申请（命令原文、模型、价格快照、`--max-usd`）
  - [ ] ⑤-5 付费执行与结果（仅在用户对该次批次授权后；复跑另行授权）
