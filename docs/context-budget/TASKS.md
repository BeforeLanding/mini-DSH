# 任务清单

更新：2026-09-30。每项只保留当前状态和证据入口；行为、边界、逐步提交与完整验收记录见 [CHANGES](CHANGES.md)。状态：`todo`、`in_progress`、`blocked`、`done`。

## 待办

下一步主线是 **NX-08 真实模型任务对照与估算误差实验**。整批上限、各臂一致的单次 run 预算与预注册口径见 [PLAN 的评测批次上限](PLAN.md#nx-08-评测批次上限预注册)；这些参数固定前不得开始真实模型调用。

| 子步骤 | 内容 | 验收 | 提交边界 |
| --- | --- | --- | --- |
| NX-08c | 输入估算误差实验 | 中文、英文、代码、schema 四类均有相对误差分布与低估幅度，结论标注 estimator 版本与核验日期 | 1 次 |
| NX-08d | 筛查跑（12 任务 × 1） | 报告原始分子/分母与失败案例；不可行任务如实标记为不可行且不计入成功率 | 1 次 |
| NX-08e | 对照 A：全历史 vs 现有裁剪 | 仅用能安全容纳全量输入的任务，两臂预算一致、每题 3 次；报告通过率、回归失败数、编辑失败率、修复迭代次数、人工介入、provider/estimated token 分列、每成功任务有效 token、延迟与停止原因 | 1 次 |
| NX-08f | 对照 B：现有裁剪 vs 裁剪加有界工具输出 | 同 e，其余条件与 A 一致；两次比较的结论分开陈述，不合并收益 | 1 次 |
| NX-08g | 评测报告与结论 | 含样本量、重复间波动、失败案例、成本与不可行项；不写未验证的提升比例，明确区分 harness 行为与真实模型能力 | 1 次 |

其他待办，按依赖排序：

- **NX-16 持久化结构化编程任务状态与可选 compaction — todo（条件阶段，依赖 NX-08）**：只有评测确认当前 task 膨胀仍是主要失败源后才实现 compaction；实施前必须修订 R-03/D-02 的“当前 task 所有 run 原文进入请求”契约，不能作为小优化塞入。范围见[路线图 M8](../INTERNSHIP_ROADMAP.md)。
- **NX-09 README 增加定位、原创增量、架构图与 5 分钟运行入口 — todo**：不依赖 NX-08，可先行；真实模型结果一节须等 NX-08 完成后回填，不得提前填写期望提升比例。
- **NX-10 固定代码修复演示 — todo**：展示项目规则→定位→修改→失败测试→再修复→diff 与证据；另需展示预算停止/恢复和 unknown。
- **NX-11 整理设计取舍 — todo**：事件与投影分离、协议完整性、可靠编辑、验证时效、未知副作用恢复，须能从代码和测试解释选择。
- **T6 Biome 只读诊断与处置 — todo**：先诊断告警数量与类别、评估修绿成本，再由用户选择修到绿并设为门禁、或移除 Biome；选定前不修改 Biome、依赖或 CI 门禁。

## 已完成

- **NX-08b 评测运行器与整批上限强制 — done**：`scripts/eval-runner.ts` 按阶段串行执行并核算 runs/requests/tokens 累计值，触顶中止阶段且不记作任务失败，已开始的 run 不被中途终止；`scripts/eval-fixture.ts` 提供适配器注入的 fixture 驱动，`pnpm eval:offline` 用模拟模型跑完筛查阶段全部 12 个任务；单次预算与整批上限的分工已写入 [PLAN](PLAN.md#nx-08-评测批次上限预注册)；[详细证据](CHANGES.md#nx-08b-评测运行器与整批上限强制)。
- **NX-08a 评测批次上限与事件导出契约 — done**：`context/projection` 带可选 `requestId` 并与随后 `model/start` 同号，未发出的请求因此可辨；`requestTrace` 增 `projectionLink`、`unsentProjections`，并补齐 run 终值 `counters`（含主动与审批时间）；[详细证据](CHANGES.md#nx-08a-评测导出契约与投影归属)。
- **OPS-01 停止文档提交触发生产部署 — done**：提交 [2ac85bd](https://github.com/BeforeLanding/mini-DSH/commit/2ac85bd1bcd69b85ed0329847cf3791a87472bd4)、纯文档探针 `92507d4`、[CI 36662206000](https://github.com/BeforeLanding/mini-DSH/actions/runs/36662206000)；[详细证据](CHANGES.md#ops-01-停止文档提交触发生产部署)。
- **OPS-02 CI push 路径过滤 — done**：提交 [263d439](https://github.com/BeforeLanding/mini-DSH/commit/263d439efd064ba27870dd8b2e6d95c11e581430)、[CI 36662938984](https://github.com/BeforeLanding/mini-DSH/actions/runs/36662938984)、纯文档提交 `ef46988` 为 0 个 run/check；[详细证据](CHANGES.md#ops-02-ci-push-路径过滤)。
- **OPS-03 文档当前状态化 — done**：PROGRESS 归档提交 `ef46988`；TASKS/CHANGES 证据迁移为本步提交；[详细证据](CHANGES.md#ops-03-文档当前状态化)。
- **OPS-04 修订提交粒度规则 — done**：以独立回退与可观察行为差异为判据，按能力类别分组 fixture；[详细证据](CHANGES.md#ops-04-修订提交粒度规则)。
- **OPS-05 版本标签与发布锚点 — done**：定义 `vMAJOR.MINOR.PATCH`、CI 前置、不可移动标签、Release 与回滚映射；[详细证据](CHANGES.md#ops-05-版本标签与发布锚点)。
- **NX-04 文档当前/历史状态清理与 F1–F3 回归接入 CI — done**：文档歧义由 OPS-03 处理；F1 回归见 `test/context.test.ts` 的投影输出额度重算用例（`mode === 'exact'` 保留旧任务并发 100 输出额度），F2 见 `test/deadline.test.ts` 的终态 sync 跨 deadline、有界收尾与错误路径独立上界用例，F3 见 `test/store.test.ts` 的崩溃重放投影合并用例；三者随 `pnpm test` 进入四组合 CI。详见 [CHANGES](CHANGES.md#f1-输出额度与历史裁剪联动)。
- **NX-06 请求 trace 与编程结果报告 — done**：提交 [08158b9](https://github.com/BeforeLanding/mini-DSH/commit/08158b9)、[CI 36661121345](https://github.com/BeforeLanding/mini-DSH/actions/runs/36661121345)；[详细证据](CHANGES.md#nx-06-请求-trace-与编程结果报告)。
- **NX-05b 将编程任务集扩展到 12 项 — done**：提交 [53e5aba](https://github.com/BeforeLanding/mini-DSH/commit/53e5aba)、[CI 36657576782](https://github.com/BeforeLanding/mini-DSH/actions/runs/36657576782)；[详细证据](CHANGES.md#nx-05b-将编程任务集扩展到-12-项)。
- **NX-15 编程验证记录与交付报告 — done**：提交 [87360a1](https://github.com/BeforeLanding/mini-DSH/commit/87360a1)、[CI 36653379987](https://github.com/BeforeLanding/mini-DSH/actions/runs/36653379987)；[详细证据](CHANGES.md#nx-15-编程验证记录与交付报告)。
- **CD-02 修复服务器 GitHub 下载失败 — done**：提交 [c9f452c](https://github.com/BeforeLanding/mini-DSH/commit/c9f452c)、[Deploy ECS 36574173979](https://github.com/BeforeLanding/mini-DSH/actions/runs/36574173979)；[详细证据](CHANGES.md#cd-02-修复服务器-github-下载失败)。
- **CD-01 阿里云 CLI 发布 — done**：提交 [a632121](https://github.com/BeforeLanding/mini-DSH/commit/a632121)、[Deploy ECS 36550955877](https://github.com/BeforeLanding/mini-DSH/actions/runs/36550955877)；[详细证据](CHANGES.md#cd-01-阿里云-cli-发布)。
- **NX-14 结构化命令执行结果 — done**：提交 [557f27f](https://github.com/BeforeLanding/mini-DSH/commit/557f27f)、[CI 36651228195](https://github.com/BeforeLanding/mini-DSH/actions/runs/36651228195)；[详细证据](CHANGES.md#nx-14-结构化命令执行结果)。
- **NX-13 可靠编辑、冲突与变更交付 — done**：提交 [4c9501c](https://github.com/BeforeLanding/mini-DSH/commit/4c9501c)、[CI 36545691239](https://github.com/BeforeLanding/mini-DSH/actions/runs/36545691239)；[详细证据](CHANGES.md#nx-13-可靠编辑冲突与变更交付)。
- **NX-12 coding profile 与仓库上下文 — done**：提交 `c5dd04b`～`20e8e3b` 及最终集成证据；[详细证据](CHANGES.md#nx-12-coding-profile-与仓库上下文)。
- **NX-12 Windows 短路径 junction 修复 — done**：[详细证据](CHANGES.md#nx-12-ci-修复windows-短路径-junction)。
- **NX-05a 三个编程 fixture 与独立验收 — done**：[详细证据](CHANGES.md#nx-05a-三个编程-fixture-与独立验收)。
- **F1 输出额度与历史裁剪联动 — done**：[详细证据](CHANGES.md#f1-输出额度与历史裁剪联动)。
- **F2 最终持久化 deadline 与提交不确定性 — done**：[详细证据](CHANGES.md#f2-最终持久化-deadline-与提交不确定性)。
- **F3 崩溃恢复的投影观测一致性 — done**：[详细证据](CHANGES.md#f3-崩溃恢复的投影观测一致性)。
- **CB-00 文档基线 — done**：[详细证据](CHANGES.md#cb-00-文档基线)。
- **CB-17 恢复开发基线 — done**：[详细证据](CHANGES.md#cb-17-恢复开发基线)。
- **CB-15 TypeScript 工具链与迁移 — done**：[CI 36504218629](https://github.com/BeforeLanding/mini-DSH/actions/runs/36504218629)；[详细证据](CHANGES.md#cb-15-typescript-工具链与迁移)。
- **CB-01 配置与预算契约 — done**：[详细证据](CHANGES.md#cb-01-配置与预算契约)。
- **CB-02 执行状态与事件 — done**：[详细证据](CHANGES.md#cb-02-执行状态与事件)。
- **CB-11 JSONL 事件存储 — done**：[详细证据](CHANGES.md#cb-11-jsonl-事件存储)。
- **CB-03 模型 usage 与输出限制 — done**：[详细证据](CHANGES.md#cb-03-模型-usage-与输出限制)。
- **CB-12 Session 重建与未知执行识别 — done**：[详细证据](CHANGES.md#cb-12-session-重建与未知执行识别)。
- **CB-04 请求 token 估算 — done**：[详细证据](CHANGES.md#cb-04-请求-token-估算)。
- **CB-05 上下文裁剪与输出投影 — done**：[详细证据](CHANGES.md#cb-05-上下文裁剪与输出投影)。
- **CB-06 步数与工具调用调度 — done**：[详细证据](CHANGES.md#cb-06-步数与工具调用调度)。
- **CB-07 Deadline 与用户取消 — done**：[详细证据](CHANGES.md#cb-07-deadline-与用户取消)。
- **CB-08 累计 token 预算接入 — done**：[详细证据](CHANGES.md#cb-08-累计-token-预算接入)。
- **CB-13 预算停止后的 `/continue` — done**：[详细证据](CHANGES.md#cb-13-预算停止后的-continue)。
- **CB-09 CLI 与用户文档 — done**：[详细证据](CHANGES.md#cb-09-cli-与用户文档)。
- **CB-10 集成验收与交接 — done**：[CI 36508829785](https://github.com/BeforeLanding/mini-DSH/actions/runs/36508829785)；[详细证据](CHANGES.md#cb-10-集成验收与交接)。
- **CB-18 实习导向评估与后续规划 — done（评估）**：[CI 36514313704](https://github.com/BeforeLanding/mini-DSH/actions/runs/36514313704)；[详细证据](CHANGES.md#cb-18-实习导向评估与后续规划)。
- **CB-19 按 mini coding agent harness 定位修订路线 — done（文档）**：[详细证据](CHANGES.md#cb-19-按-mini-coding-agent-harness-定位修订路线)。
- **NX-07 有界代码读取、搜索与大结果回读 — done**：提交 [6c03300](https://github.com/BeforeLanding/mini-DSH/commit/6c03300)、[CI 36538591870](https://github.com/BeforeLanding/mini-DSH/actions/runs/36538591870)；[详细证据](CHANGES.md#nx-07-有界代码读取搜索与大结果回读)。
