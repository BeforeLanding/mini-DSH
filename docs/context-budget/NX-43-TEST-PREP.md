# NX-43 零付费测试准备（2026-10-17）

## 版本与证据

开工时 `D:/Agent/mini-DSH` 的公开跟踪主分支 HEAD 为 `73f34399ebac9606e05862cf7aef9d661f577c55`，有未提交改动，未触碰。有效开发工作树 `D:/Agent/mini-DSH-nx42` 为干净的 `nx42-benchmark-v2`，基线 HEAD `15f865e036814d408bce9523f18fa0b9a80acf2f`。八批实际运行代码 SHA 逐批来自各自 manifest，见外部新索引 `D:/Agent/outputs/mini-dsh-history-index-20261017.json`。索引记录 manifest/report/runs 的 SHA-256、任务快照摘要、预算和三项 C/P 设置、计划与执行数、失败类型、费用快照及 usage 不确定性。用 `node scripts/eval-history-audit.mjs D:/Agent/outputs` 可从原件重建，原目录未改动。

本地八批共执行 137 条；各批报告的**已知估算**合计 `$17.11320996`，由报告中的 usage 和当批 manifest 价格快照而来，非供应商账单。`nx42-infra-guard-2m-20261016` 有 2 条、`nx42-post-report-2m-20261016` 有 15 条估计或缺失 provider usage；报告合计不能解释为完整账单，未知增量不能填零。不同代码和题目版本的效果数据不合并。此前冻结的 v2 正式 240 条清单仍是旧代码/工具装配版本，不可执行为本次新协议结果。

## 失败事件复核

`node scripts/eval-failure-audit.mjs D:/Agent/outputs/nx42-post-report-1m-20261016` 生成脱敏结构数据 `D:/Agent/outputs/mini-dsh-failure-audit-20261017.json`，只输出事件号、状态、用量与计数，不输出推理正文、命令或工具结果。

- TC01/0/Full：最后 `model/start` seq 86、`model/usage` seq 419、`model/end` seq 420；输入 11,696，输出及 reasoning 各 16,384，`complete=false`、`finishReason=length`。TC01/1/Full 对应 seq 79/471/472，输入 10,692，输出及 reasoning 各 16,384，同为不完整 `length`。两个 episode 均无摘要请求；终止请求后没有可执行 `assistant/tool_calls`。可证实为输出上限处未形成完整工具调用，不能证实是压缩所致，也不能据此推论 Full 应胜出。
- RC01 四条记录均为 `token_budget`。依次按 Baseline/0、Full/0、Baseline/1、Full/1：主请求 27/29/34/36，摘要 0/2/0/2，文件变更 9/8/8/6，显式验证 4/14/8/11。相同工具名与参数的重复读取 7/17/22/8 次；文件未变期间同命令与文件范围的重复验证 1/1/0/1 次。
- RC01 按**整次请求后的动作**互斥归类，估算总 token（含该请求重复发送的输入）：修复 193,360/154,206/191,197/55,459；验证 368,631/246,046/277,630/324,180；读取 252,993/286,384/243,011/171,080；收尾或无工具 175,658/282,668/282,697/387,197；摘要 0/24,019/0/50,585。一次请求可能同时包含多种动作，因此这些是操作性分桶，**不是工具动作的精确因果成本**；`closing` 也包括无工具的模型轮，不能全称为浪费。重复读取按完全相同参数计，变更后重新读取可能合理。后续若需精确归因，应先增加不含敏感内容的逐动作账本。

## 装配与协议边界

当前生产与新版 v2 共用 `src/app/create-harness.ts`。适配器、`commandRunner`、审批、workspace、prompt layout、工具结果预览均显式注入；旧 fixture 装配留在 `scripts/eval-fixture.ts` 的 legacy 分支。四臂通过同一装配获得 `read_history`，无 Full 专属工具。`node scripts/eval-capabilities.mjs` 生成 `D:/Agent/outputs/mini-dsh-capabilities-20261017.json`；工具 schema SHA-256 为 `f6709d6264ca8e33861cfe1d558def388fce12f87af5e1c3559a00381e5d9c87`（当前源码）。四臂允许的差异仅 `budget.inputTargetTokens`、`budget.compactionBudgetTokens`、`toolOutput.bounded`、`promptLayout.frozen`；adapter、runner 与审批是环境注入项。真实评测运行入口现在拒绝旧 v2 manifest；新冻结使用 `NX-42-eval-v2.1`，必须待提交后按新 HEAD、当时价格与固定参数另行冻结，不能改写旧 manifest。

已有日志保存事件、响应片段、usage 和结束原因，但**没有完整请求的 model/options、system 文本、messages、工具 schema 及可验证请求指纹**。所以不能将旧记录声称为严格录制回放；本阶段未伪造 replay pass，也未在真实用户目录重放副作用。针对性离线测试覆盖不完整响应不执行部分调用、摘要预算、预算停止、unknown 不重试、事件号回读和 schema 一致。将来录制时须分开主/摘要流，记录脱敏但可校验的请求指纹、usage 和 finishReason；仅可在隔离 fixture 中执行副作用，请求不匹配即失败且无 API 回退。

## 最小真实模型 smoke 清单（待单独授权）

以下是下一阶段的**计划**，本阶段调用数为零。所有场景固定模型 ID、精确模型版本/回显、thinking、sampling、输出上限、上下文窗口、预算、tool schema SHA、代码 SHA、题目 SHA、provider endpoint 与价格快照；主/摘要均入账。先取当时官方价格和最坏请求数计算金额上限，未知 usage 即停，不沿用旧授权。

1. **协议探针，最多 2 次请求**：验证新冻结模型回显、工具流、usage 和 `finishReason`；离线适配器不能证明服务端当前协议。缺任一字段或不完整流不执行工具即失败。
2. **压缩后回读，最多 4 次主请求 + 1 次摘要**：隔离 fixture 中放一条哨兵事实，要求摘要后按 seq 使用 `read_history`；离线只能证明机制，不能证明真实模型会选择回读。成功是回读原字节并遵守约束，失败包括臆造、越权或缺事件号。
3. **短修复与预算收尾，最多 6 次主请求 + 1 次摘要**：验证真实模型能完成一个预先固定的短任务并正常停止；离线脚本不能评估模型决策。成功是产物验收和可靠完成同时成立；预算停止、输出上限、未知副作用均按失败/未完成计。

三项按序独立停机，不因 Full 结果追加重跑；这只是机制与可行性 smoke，不估计四臂效果。价格与保守金额上限尚未取得，故现在没有执行授权，也未开始正式 240 次实验。
