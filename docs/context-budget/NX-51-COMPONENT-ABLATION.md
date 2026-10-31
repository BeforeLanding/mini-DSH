# NX-51 三项组件的逐项消融：四臂 leave-one-out（2026-10-27 收口）

状态：**零付费准备；未执行、未授权付费批次**。协议 ID 为 `NX-51-component-loo-v1`，split 为 `component-loo`。四份 manifest 各自 12 条 episode，合计 48 条；每份 manifest 仍只有一条 `context` 执行臂，`variant` 字段标识源码变体。任何 `--execute`、协议探测或复跑都需要单独的金额与批次授权。

本文件不改变 NX-50 的门槛或结果，也不把四臂读数并入 NX-42 的正式题库。NX-51 的“摘要后裁剪”机制虽已保留，但四臂统一使用 manifest 中显式冻结的 `postCompactionPrune=false` 背景；24 条开/关对照没有支持摘要下降假设，详见 [NX-51-PRUNE-RESULT](NX-51-PRUNE-RESULT.md)。

## 要回答的问题

NX-50 只验证了“三项组件一起上”不越过可靠完成/产物验收/token/耗时的预注册容差；`gate=pass` 不等于任何一项组件有正贡献。逐项消融要回答：

1. 去掉某一项组件后，真实任务的输出 token、主动耗时、请求数、摘要次数是否变差？
2. 变差是否伴随可靠完成或产物验收下降？如果只是更快但更容易失败，不算收益。
3. 三项组件的方向是否一致，还是互相抵消（例如预览保留尾部让模型少回读，却让上下文变长、更早触发摘要）？

## 设计：四份独立 manifest

以“三项全开”为参照，对每项组件各做一个只回退该项的源码变体。每一项的读数是**在另外两项仍开启时的边际贡献**。

| variant | 预览头尾共享额度 | 摘要可见性投影 | 报告查询共享文件版本 | 相对 `full` 的精确源码差异 |
|---|---|---|---|---|
| `full` | 开 | 开 | 开 | 无 |
| `no-preview` | **关** | 开 | 开 | `src/core/tool-result-store.ts`、`src/plugins/tool-results.ts` |
| `no-projection` | 开 | **关** | 开 | `src/core/compaction-plan.ts` |
| `no-report` | 开 | 开 | **关** | `src/core/file-edit.ts`、`src/core/task-changes.ts`、`src/core/task-verification.ts` |

- `no-preview` 回退 `00c8e32`＋`14a0d1c` 的预览行为；`scripts/eval-precheck.ts` 不回退，否则脚本化探针会欠填两条流。
- `no-projection` 回退 `cd17cbc` 的可见性索引，恢复逐事件扫描；可见输出必须与优化版逐字相同，只允许资源量不同。
- `no-report` 回退 `fda47d0` 的查询内文件版本共享，恢复按检查条目重复读盘；报告证据字段必须不变。
- 四臂的 tool schema、系统提示、`context` 臂预算、模型、thinking、采样、窗口、价格快照必须逐字相同；manifest 只允许 `variant`、`sourceBaseCommit`、`gitCommit`、派生 `digest` 与上表精确 `src/**` 文件哈希差异；测试适配不在冻结源码清单内。`package.json` 必须完全相等，不沿用 NX-50 的“`bench:components` 只出现在优化版”规则。
- 每份 manifest 的 `sourceBaseCommit` 是被测源码提交，`gitCommit` 是同一份评测代码（比较器、协议、文档）cherry-pick 到该源码提交之后的 HEAD。这与 NX-50 的“两版各自冻结”是同一模式，只是从两版扩展到四版。

## 机器验收合同

- `scripts/eval-v2-component-protocol.ts` 集中维护本协议 ID、seed、重复数、12 条分母、四批顺序、源码允许路径、裁剪关闭与归因阈值；冻结器、计划、报告与比较器共享配置。
- NX-50 的 `component` / `NX-50-component-ab-v1`、new-first 与只添加 `bench:components` 的历史例外保持不变。LOO 不继承该脚本例外，包文件必须完全相等。
- 报告按固定题目/重复/执行臂重算；四臂即使共同改了 seed、预算、裁剪开关或 episode 顺序，也不能通过。重复观察、伪造汇总、缺失 provider usage、停止/不完整批次均拒绝。
- 不只校验 full 先跑：四批时间窗不能重叠，必须完整遵循 `full → no-preview → no-projection → no-report`。
- 必须恰好改变表内源码路径，少一个、多一个、删除/新增路径都拒绝；其余冻结源码、fixture、tool schema、包文件与模型合同一致。
- 新 manifest 必须重新冻结；2026-10-26 分支的准备材料保留为历史记录，不能充作本轮的冻结验证或付费证据。

## 任务与预算

- 沿用 NX-50 的六道开发题：`U02`、`B03`、`F01`、`F02`、`R04`、`T04`。它们已经被 NX-50 曝光，因此本批只能作**开发期归因**，不能宣称正式留出集或泛化。
- 每题 2 次重复，四臂共 **48 个 episode**。顺序 seed 为 `20261026`，四臂逐字相同；seed 只固定题目与重复的顺序，不控制模型采样。
- 整题预算沿用 NX-50 `context` 臂：65,536 输入目标、主动压缩、16 KiB 有界预览、`live` 提示布局、64 请求、128 工具、1,000,000 token、600 秒主动时间、单条输出 16,384。
- 模型合同沿用 `deepseek/deepseek-flash`、`DeepSeek-V4.1-Flash-1017`、`thinking: enabled`、`1m` 档、`provider-default`；本轮零付费验证沿用 2026-10-26 的模型/价格快照，不声称它是 2026-10-27 的实时价格；实际付费前须重新核对官方价格与 thinking 参数并重新冻结。
- 价格快照（2026-10-26 核对，峰值）：缓存命中输入 `$0.006`、未命中输入 `$0.30`、输出 `$1.20` 每百万 token。
- 按 NX-50 的保守算法，每条 episode 上限 `$1.7596608`，12 条加协议探针约 `$21.14`；单批金额上限 `$22`，四批合计不超过 `$88`。这是最坏情况储备，不是预计账单；实际值按 provider usage 重算，不当作供应商账单。

## 读数与归因

每份 manifest 固定 12/12，missing/invalid/`stopped` 不补跑、不缩小分母。报告至少包含：

- 可靠完成（`completed` 且四组合同、产物验收、受保护文件、证据完整）与产物验收；
- provider 覆盖的 `input + output`、输出与推理 token、cache-read（不当作总 token 下降）；
- 主动耗时、逐请求耗时、模型等待、摘要次数/耗时/token、工具调用/错误、预览截断、压力压缩；
- 付费侧的本地开销代理 `nonModelActiveDurationMs = Σ max(0, activeDurationMs − Σ requestDurationsMs)`。它包含工具执行、隔离与本地 I/O，**不是 CPU 时间**；投影/报告归因不得只看总主动耗时。
- 每项组件的 `full - no-X` 配对差值，按题与重复分别展示，不只给聚合。

离线探针（每臂在源码提交上运行 `scripts/benchmark-components.mjs --out`，零 provider 请求）：

- 预览：`withinLimit`／`tailVisible`／`fullRecall` 与可见字节，回答“信息保留”；
- 投影：`propertyReads` 与中位耗时，回答“可见性索引的 CPU 成本”；
- 报告：`snapshotOpens`，回答“查询内文件版本共享的 I/O 成本”；
- 探针的 `suiteSha256`、case id、投影/报告的 `outputSha256` 必须与 `full` 一致；`sourceCommit` 必须等于对应 manifest 的 `sourceBaseCommit`。

归因用描述性规则，不设“显著性”门槛：

- `signal`：去掉 X 后，付费输出 token 或主动耗时变差 **≥5%**（预览臂），或付费 `nonModelActiveDurationMs` 变差 **≥5%**（投影/报告臂），且离线机制同时显示 `withinLimit/tailVisible` 下降、`propertyReads` 上升或 `snapshotOpens` 上升；可靠完成/产物验收下降不超过 1 条 episode，重复方向不矛盾。
- `efficiency-tradeoff`：去掉 X 后资源变好 ≥5%，但可靠完成或产物验收下降 ≥1 条；更快不是收益。
- `inconclusive`：变化 <5%、方向在两次重复间相反、离线机制未确认，或只有总主动耗时变化而 CPU/I/O 代理无变化。
- 可靠完成或产物验收在任一方向相差超过 1 条时 `reviewRequired=true`，先审该题轨迹，不能只因总量过关就写结论。

5% 是诊断阈值，不是统计显著性；48 条只够开发期排序，不足以为正式题库下结论。离线机制与付费读数分栏呈现，离线变差不自动升级为付费 `signal`。

## 冻结、预检与执行顺序

1. 四臂从同一个干净 `main` 基线派生：`full` 不改 `src/**`；三个变体各做一个只含预期 `src/**` 与测试适配的源码提交；同一份评测代码 cherry-pick 到四个源码提交之上。
2. 每臂从各自的干净 HEAD 生成 manifest，并做 `--validate-only`。任一步失败即停止，不发起模型请求。
3. 先跑 `full`，确认装配、证据目录与 12/12 完整；再按固定顺序跑 `no-preview`、`no-projection`、`no-report`。任一批次 incomplete 即停，不用另一批补齐。
4. 付费前单独列出模型、任务、重复、金额上限与证据目录，取得**该批**授权；复跑需重新授权。
5. 不合并任何一臂到 `main`、不发布、不改写 NX-50 或 NX-51 的原始证据。

比较器保留 NX-50 的 `compareV2Batches`，另提供 LOO 模式：一个 `full` 参考批＋三个带标签的变体批，按 `taskId/repeat` 配对，输出每臂的资源/质量差值、逐题逐重复读数、精确源码差异、离线探针读数和描述性归因。

## 证据与边界

- 四臂证据目录各自独立；准备阶段的 config/manifest/探针放在仓库外的 `D:\Agent\outputs\component-eval-closure-20261027\`。
- 原始 prompt、模型输出和工具正文不写入公开仓库；公开报告只引用 provider usage 重算的估价与聚合读数。
- 本批只回答三项组件的开发期归因，不回答正式题库、泛化、统计显著性，也不把任一 `signal` 包装成因果结论。
- 六道题在本批使用后仍是开发题；未来正式批次必须重新冻结题库。

## 相关记录

- [NX-51 摘要后裁剪 24 条结果](NX-51-PRUNE-RESULT.md)：负结果与默认关闭决定。
- [NX-51 变慢任务离线诊断](NX-51-TIMING-DIAGNOSIS.md)：耗时分解与已落地的时序修复。
- [NX-50 结果](NX-50-RESULT.md)：组合门槛与逐题读数。
- [NX-50 协议](NX-50-COMPONENT-AB.md)：装配、预算、冻结与门槛。
- [评测证据边界](../EVALUATION.md)：开发批、合成样本与正式证据不能互换。
