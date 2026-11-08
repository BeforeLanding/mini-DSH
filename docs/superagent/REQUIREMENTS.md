# 多 Agent 编排需求（Super Agent 方向）

- **状态：** M0—M4 的离线部分已完成；M1—M4 在 `feat/orchestration-m1`—`m4` 分支链上，待评审合并，main 尚未包含编排入口。M4 的真实模型小批次需单独授权、尚未执行。本文件只记录目标、范围与验收，领域契约以 [DEVELOPMENT.md](DEVELOPMENT.md) 为唯一来源。
- **基线：** `main@91de468`（v0.2.0）；开发分支 `feat/orchestration-m1`（M1）、`m2`（M2）、`m3`（M3）与 `m4`（M4）。
- **日期：** 2026-11-08。

## 目标

在 mini-DSH 上实现"同一根任务内、宿主驱动的多写入者闭环"：规划 → 校验 → 在独立 git worktree 中并行执行 → 宿主提交与写集检查 → 确定性整合 → 整合后复验 → 报告。方案 A（只读委派）已按 M0 移植回 main，默认关闭；MVP 的新增能力是 [DEVELOPMENT.md](DEVELOPMENT.md) §2.4 的方案 B 最小形态。

可观察增量按里程碑划分：

| 里程碑 | 可观察增量 |
| --- | --- |
| M0 | `MINI_DSH_DELEGATION=read-only` 时只读子 Agent 并发委派、共用任务组预算、崩溃后不重跑；默认关闭时行为与 v0.2.0 一致 |
| M1 | `orchestrate run --plan` 在 worktree 中由一个 worker 完成子任务，宿主提交、整合、验收并输出报告；`orchestrate inspect` 可查看事件与账目 |
| M2 | 两个 worker 并行；计划校验拒绝同波次写集相交；冲突产生人工请求；planner 可替代计划文件 |
| M3 | 崩溃后 `resume` 采用已完成结果、不重跑、未知用量需人工确认；两级 Ctrl-C |
| M4 | 三个离线演示；四臂对照执行器离线装配与零付费校验；获授权后的小批次付费结果 |

## 范围与非目标

范围、裁剪顺序与延后能力见 [DEVELOPMENT.md](DEVELOPMENT.md) §2.5、§2.6、§13。不可裁剪的底线：写前日志、根账本、attempt 不自动重跑、写集检查、整合后复验、用户工作树不被修改。

## 审批策略（D8，已确认 2026-11-06）

仅 `orchestrate` 模式：

1. worktree 内的文件工具写入默认自动批准；
2. Bash 仍默认需要人工批准，经单一 FIFO 队列逐条提示；
3. `--approve-writes ask` 恢复逐条审批；
4. 单 Agent CLI 的审批行为完全不变。

## 验收

每个里程碑的验收项与关键失败用例见 [DEVELOPMENT.md](DEVELOPMENT.md) §13；当前状态与证据见 [TASKS.md](TASKS.md) 与 [CHANGES.md](CHANGES.md)。离线测试只证明机制，不证明模型能力；未获单独授权的付费评测不执行。
