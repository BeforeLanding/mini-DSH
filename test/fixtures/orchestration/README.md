# 多 Agent 编排组合夹具（M4-①）

这些夹具给 [DEVELOPMENT.md](../../../docs/superagent/DEVELOPMENT.md) §14.3 的并行/单任务评测装配使用。它们不是新的 coding fixture：每一份把既有 [coding fixture](../coding/README.md) 的参考解与隐藏验收器搬进同一个仓库的不同子目录，让多个 worker 在互不相交的路径上写入，再由宿主整合与复验。

| 夹具 | 子任务 | 形状 | 来源 |
| --- | --- | --- | --- |
| `parallel-composite` | `st-1` normalize、`st-2` dedupe、`st-3` report（依赖前两者） | 两波次：`[[st-1, st-2], [st-3]]` | 前两个复用 coding 的 `normalize`/`dedupe`；`report` 是本目录新增的跨包任务 |
| `single-repair` | `st-1` 修购物车金额 | 单波次、单 worker | 复用 coding 的 `repair`（项目规则 `AGENTS.md` 一并保留） |

## 两套验收

| 名称 | 位置 | 谁运行 | 用途 |
| --- | --- | --- | --- |
| 冒烟检查 `check.mjs` | 工作区内，作为计划里的验收命令 | 宿主在整合 worktree 中运行 | 计划验收命令只能引用工作区内相对路径（命令闸门拒绝工作区外路径），因此它只给每个包一个例子 |
| 隐藏验收器 `verify.mjs` / `verify/report.mjs` | 工作区之外，不进入 plan 或日志 | 演示脚本、离线评测与 `test/orchestration-fixtures.test.ts` 在整合结果上独立运行 | 覆盖更多边界；它的读数才是演示/评测的最终验收结论 |

`parallel-composite` 的隐藏验收器复用 `test/fixtures/coding/<id>/verify.mjs`（目标为 `packages/<id>`）；`report` 的隐藏验收器在本目录的 `verify/report.mjs`，期望值同时检查跨包 import 与依赖产物已整合。

## 必要规格条款

每个夹具在 `orchestrationFixtures[id].requiredClauses` 登记隐藏验收器要求的语义（`id`、逐字 `text`、对应断言说明）。`checkClauseVisibility(spec)` 检查装配出的每个 RunSpec：条款须出现在 `goal`（S/D 只能读到 goal；R/R-serial 另有计划 objective）。它只证明已登记条款到位；条款与隐藏断言是否对应由人工审核。

## 反例产物（`weak/`）

每个夹具的 `weak/` 是覆盖在参考态上的反例：公开冒烟检查能通过，但违反隐藏验收器的某条断言。`validateOrchestrationFixture` 返回 `weakRejected`（验收器真的跑出失败读数）与 `weakFailedTasks`；`--validate-only` 与测试都要求它为真。

- `parallel-composite/weak`：先 `uniqueById` 再列名的 `report.mjs`，即 batch-01 中 S 臂的写法（import 路径改为本夹具的文件布局）；只在 `st-3` 上失败。
- `single-repair/weak`：只接受 `0 < discount < 1` 的“防御式”`cart.mjs`，discount 为 1（该项免费）时被当成无折扣。

## 材料化与校验入口

`scripts/orchestration-fixtures.ts` 提供：

- `materializeOrchestrationFixture(id, directory, { reference })`：按初始态或参考态装配工作区；
- `fixturePlan(id)`：生成计划（写集、依赖、冒烟验收命令）；
- `evaluateOrchestrationFixture(id, workspace)`：运行隐藏验收器并返回逐任务读数；
- `validateOrchestrationFixture(id)`：零模型调用的正反例校验（初始态拒收、参考态通过、计划分层正确）。

这组夹具只证明机制与装配，不证明模型能力；真实模型批次需要单独授权（见 §14.4 与 M4 文档）。
