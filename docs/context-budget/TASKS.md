# 任务清单

更新：2026-09-30。每项只保留当前状态和证据入口；行为、边界、逐步提交与完整验收记录见 [CHANGES](CHANGES.md)。状态：`todo`、`in_progress`、`blocked`、`done`。

## 待办

下一步主线是 **NX-08 真实模型任务对照**。整批上限、各臂一致的单次 run 预算与预注册口径见 [PLAN 的评测批次上限](PLAN.md#nx-08-评测批次上限预注册)；筛查跑（NX-08d）已于 2026-09-30 完成，预注册参数在开跑后不得再单独调整某一臂或某次重复。离线部分（a／b／c）与开跑前的设施补齐（d0）均已完成。

NX-08e 开跑前必须先解决其前置条件（2026-09-30 修正）：裁剪要求会话中存在**已结束且可裁剪的旧任务**，单任务会话无论多大都不会触发——当前 task 与 `/continue` 的续跑段恒受保护（依据见 [PLAN 的对照有效性条件](PLAN.md#nx-08 评测批次上限预注册)）。现有驱动每个 fixture 只发一次 `send`，因此筛查跑的 `removedTaskIds` 全为空属结构性必然。前置工作是把评测驱动改成能在同一会话内下发任务序列，并实测这些旧任务的累计规模；对照 A 采用同仓库、后阶段依赖前阶段产物的多阶段任务序列。

| 子步骤 | 内容 | 验收 | 提交边界 |
| --- | --- | --- | --- |
| NX-08d0-1 | 评测预算接入上下文目标与模型窗口能力 | 极小 `inputTargetTokens` 经真实 Harness 跑出 `context_overflow`；适配器未声明 capabilities 时给出明确错误；`pnpm eval:offline` 仍 12/12 | 1 次 |
| NX-08d0-2 | run 结论分类与显式分子分母 | 拒绝但可解、不可行、基础设施失败三类各自进入正确的分子/分母口径 | 1 次 |
| NX-08d0-3 | 逐 run 证据落盘与 `pnpm eval:screening` 真实适配器入口 | 烟测 1 个任务：模型名被接受、回显 `model`、原始 usage 与 `reasoning_tokens` 记录、会话与结果 JSONL 可读回 | 1 次 |
| NX-08d0-4 | d0 文档回填与烟测结论 | 文档记录的命令与实际执行一致 | 1 次 |
| NX-08e | 对照 A：全历史 vs 现有裁剪 | 前置（2026-09-30 修正）：会话中必须存在**已结束且可裁剪的旧任务**，其累计估算输入还要足以让 `fits` 为假；当前 task 与续跑段恒受保护，加大单个任务无效。筛查跑 12 个 fixture 的单任务会话 `removedTaskIds` 全为空属结构性必然，全部不满足。对照 A 用同仓库多阶段任务序列，两臂预算一致、每题 3 次；报告通过率、回归失败数、编辑失败率、修复迭代次数、人工介入、provider/estimated token 分列、每成功任务有效 token、延迟与停止原因 | 1 次 |
| NX-08f | 对照 B：现有裁剪 vs 裁剪加有界工具输出 | 同 e 的预算、模型、prompt、验收与整批上限条件；两次比较的结论分开陈述，不合并收益。**不受 e 的会话组成前置限制**：有界工具输出改变的是当前 task 内部的历史规模，单任务会话下就会出现一臂 `context_overflow`、另一臂完成 | 1 次 |
| NX-08g | 评测报告与结论 | 含样本量、重复间波动、失败案例、成本与不可行项；不写未验证的提升比例，明确区分 harness 行为与真实模型能力 | 1 次 |

其他待办，按依赖排序：

- **NX-18 `..` 族误判 — todo（NX-17 期间发现）**：`..` 规则是整串正则，会命中引号内的惰性文本——`echo "see ../docs for details"`、`grep -n ".." src/index.ts`、`git log --grep "../ fixes"` 全部被判 `.. path escape is blocked`。该规则是用户「放宽不得削弱 `..`」条款点名保护的对象，NX-17 因此没有动它。收紧需要把判定从整串正则改为 token 级的路径操作数判定，且必须保持 `echo ../secret`、`cat ../secret`、`cp ../a b` 仍被拒；修改前先补需求/设计决策。
- **NX-19 出网拦截的真实缺口 — todo（NX-17 期间发现）**：`bash -c "curl http://example.com"`、`sh -c "wget …"`、`echo "$(curl …)"`、`nc example.com 80`、`ssh user@example.com`、反斜杠 UNC（`cat \\server\share\secret`）当前全部放行；其中反斜杠 UNC 与 NX-17 无关，是既有缺口。出网规则只覆盖「整个 token 是一个 URL 且位于命令词可识别的段内」，命令替换、内联脚本与未被识别的取网工具都在覆盖范围之外。收口属于「加强」而非「放宽」，需要单独设计与验收，不得顺手塞进 NX-17 的提交。
- **NX-16 持久化结构化编程任务状态与可选 compaction — todo（条件阶段，依赖 NX-08）**：只有评测确认当前 task 膨胀仍是主要失败源后才实现 compaction；实施前必须修订 R-03/D-02 的“当前 task 所有 run 原文进入请求”契约，不能作为小优化塞入。范围见[路线图 M8](../INTERNSHIP_ROADMAP.md)。
- **NX-09 README 增加定位、原创增量、架构图与 5 分钟运行入口 — todo**：不依赖 NX-08，可先行；真实模型结果一节须等 NX-08 完成后回填，不得提前填写期望提升比例。
- **NX-10 固定代码修复演示 — todo**：展示项目规则→定位→修改→失败测试→再修复→diff 与证据；另需展示预算停止/恢复和 unknown。
- **NX-11 整理设计取舍 — todo**：事件与投影分离、协议完整性、可靠编辑、验证时效、未知副作用恢复，须能从代码和测试解释选择。
- **T6 Biome 只读诊断与处置 — todo**：先诊断告警数量与类别、评估修绿成本，再由用户选择修到绿并设为门禁、或移除 Biome；选定前不修改 Biome、依赖或 CI 门禁。

## 已完成

- **NX-17-3 NX-17 设计决策与文档回填 — done**：设计决策（形状判据、能力判据、明确不采用的网络工具清单方案）与未放宽清单写入 CHANGES，新增 R-20 固化命令策略契约，README 说明策略范围与已知缺口，另附可复跑闸门矩阵 `docs/context-budget/nx17-gate-probes.mjs`（诊断脚本，非 CI 门禁）；[详细证据](CHANGES.md#nx-17-沙箱命令闸门误判修复筛查跑发现)。
- **NX-17-2 出网规则改用能力判据 — done**：`echo`／`printf` 参数里的 URL 不再判出网，本段接管道时仍拦截，`||` 不计作管道；`curl`／`wget` 操作数、`git clone <url>` 照旧拒绝。提交 `c4a02ae`；[详细证据](CHANGES.md#nx-17-沙箱命令闸门误判修复筛查跑发现)。
- **NX-17-1 命令分词与路径形状修复 — done**：双引号按 shell 语义识别 `\"`（事故命令由 49 token 变为 6 token，注释不再暴露为独立 token）；纯分隔符串与「首个分量含空白」的双斜杠 token 不再当路径操作数，单个 `/`、系统路径、`//etc`、`//home/…`、UNC 与 `..` 全部照旧拒绝。提交 `5322291`；[详细证据](CHANGES.md#nx-17-沙箱命令闸门误判修复筛查跑发现)。
- **NX-08d 筛查跑（12 任务 × 1，首次真实模型调用）— done**：`deepseek/deepseek-v4-flash`（服务端回显 `deepseek-flash`）跑完 12 个 fixture，**原始分子/分母 12/12**，无拒绝、无不可行、无基础设施失败，因此无可报告的失败案例；81 请求 / 412,176 token（20.3% 与 5.2% 的整批上限），81/81 usage 来自 provider，成本约 $0.15；12 次全部 `completed` 且未触发任何裁剪或预算停止（最大估算输入 17,220）。[详细证据](CHANGES.md#nx-08d-筛查跑12-任务--1首次真实模型调用)。
- **NX-08d0-3 真实适配器评测入口与逐 run 证据落盘 — done**：`pnpm eval:screening` 接入真实 DeepSeek 适配器，含协议探测（请求 `deepseek-v4-flash` 时服务端回显 `model=deepseek-flash`）、模型名与窗口显式化、逐 run 事件日志与 `runs.jsonl` 落盘、逐 run 成本打印；烟测 `merge` 两次均 completed 且通过验收（5 请求 / 24,677 token，9 请求 / 119,689 token）；[详细证据](CHANGES.md#nx-08d0-3-真实适配器评测入口与逐-run-证据落盘)。
- **NX-08d0-2 评测 run 结论分类与显式成功率口径 — done**：`RunOutcome` 增 `acceptance` 与 `infeasible`，`summarize` 输出 `rate { numerator, denominator, excludedInfeasible, excludedErrored }`，三类结果分别进入正确口径；[详细证据](CHANGES.md#nx-08d0-2-评测-run-结论分类与显式成功率口径)。
- **NX-08d0-1 评测预算接入上下文目标与模型窗口能力 — done**：修复评测路径上输入目标 65,536 与 1,000,000 窗口从未生效（投影不裁剪、`context_overflow` 不触发）的问题，新增 `evalPolicy` 与适配器 `capabilities` 透传；[详细证据](CHANGES.md#nx-08d0-1-评测预算接入上下文目标与模型窗口能力)。
- **NX-08c 输入估算误差实验 — done**：40 个样本（中文、英文、代码、schema 各 10）对照 DeepSeek 官方离线 tokenizer，四类均有相对误差分布与低估幅度；结论标注估算器 SHA-256 与核验日期 2026-09-30。自然语言一致高估（中文 +28%、英文 +40%），结构化载荷 4/40 低估、最深 −22.5%，超过 10% 的容量余量；[详细证据](CHANGES.md#nx-08c-输入估算误差实验)。
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
