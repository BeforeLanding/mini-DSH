# context-budget 目录说明

本目录是开发过程档案，了解项目不需要阅读；入口见 [项目 README](../../README.md) 与 [文档索引](../README.md)。文件分三类：在维护的工作文档、被评测冻结清单引用的协议文档、按原日期保留的历史报告与诊断探针。后两类不再更新正文。

## 在维护的工作文档

[AGENTS.md](../../AGENTS.md) 规定开发时同步这几份：

- [PLAN](PLAN.md)：设计决策、默认参数与官方依据，决策以此为准。
- [REQUIREMENTS](REQUIREMENTS.md)：需求与验收条目（R-编号）。
- [TASKS](TASKS.md)：任务拆分、当前状态与预计提交边界。
- [CHANGES](CHANGES.md)：每个步骤实际运行的命令、结果与证据，新条目在最前。
- [DECISIONS](DECISIONS.md)：五条核心取舍的替代方案与代码/测试锚点（非规范性说明）。

## 被冻结清单引用的协议文档

`scripts/eval-v2-report.ts` 的冻结清单按路径与 SHA-256 记录下列文件；移动或改动正文会使既有 manifest 无法校验，因此保持原位、原文：

- [NX-42-EVAL-V2-PLAN](NX-42-EVAL-V2-PLAN.md)：20 题 Harness Benchmark v2 方案（formal / calibration split）。
- [NX-45-DEVELOPMENT](NX-45-DEVELOPMENT.md)：两臂开发探索协议（development split）。
- [NX-50-COMPONENT-AB](NX-50-COMPONENT-AB.md)：组件优化前后的版本对照协议（component split）。
- [NX-51-COMPONENT-ABLATION](NX-51-COMPONENT-ABLATION.md)：三组件逐项消融协议（component-loo split）。

## 历史报告

按原日期保留，描述当时的实验与结论，不代表当前计划。

- [NX-08-REPORT](NX-08-REPORT.md)：NX-08 四次真实模型实验的汇总报告。
- [NX-38-REPORT](NX-38-REPORT.md)：NX-38 预注册两批四次开跑的报告。
- [NX-42-CALIBRATION-DIAGNOSIS](NX-42-CALIBRATION-DIAGNOSIS.md)：校准批次中 Full 额外调用的离线诊断。
- [NX-42-POSTFIX-TRACE](NX-42-POSTFIX-TRACE.md)：修复后 1M 批次新增上下文的离线诊断。
- [NX-42-V2-ISOLATION](NX-42-V2-ISOLATION.md)：V2 候选的 WSL2 + bubblewrap 隔离运行环境。
- [NX-42-V2-RUNBOOK](NX-42-V2-RUNBOOK.md)：V2 运行与证据手册。
- [NX-43-TEST-PREP](NX-43-TEST-PREP.md)：零付费测试准备记录。
- [NX-44-SMOKE](NX-44-SMOKE.md)：专用真实 smoke 的录制协议准备。
- [NX-44-REPAIR-REPLAY](NX-44-REPAIR-REPLAY.md)：smoke repair 的零付费限定回放。
- [NX-44-REPAIR-RETEST](NX-44-REPAIR-RETEST.md)：仅短修复重测的冻结清单。
- [NX-45-EXPLORATION-RESULT](NX-45-EXPLORATION-RESULT.md)：两臂开发探索结果与离线更正。
- [NX-45-PUBLIC-EVIDENCE](NX-45-PUBLIC-EVIDENCE.md)：NX-45 可公开审阅的脱敏证据摘要。
- [NX-45-USAGE-CORRECTION](NX-45-USAGE-CORRECTION.md)：原始 usage 的离线更正。
- [NX-50-RESULT](NX-50-RESULT.md)：组件版本对照结果。
- [NX-51-PRUNE-AB](NX-51-PRUNE-AB.md)：摘要后裁剪开/关对照协议与执行记录。
- [NX-51-PRUNE-RESULT](NX-51-PRUNE-RESULT.md)：摘要后裁剪对照结果。
- [NX-51-TIMING-DIAGNOSIS](NX-51-TIMING-DIAGNOSIS.md)：变慢任务的离线耗时诊断。
- [COMPONENT-EVAL-CLOSURE](COMPONENT-EVAL-CLOSURE.md)：组件评测收口的零付费冻结验收。
- [COMPONENT-LOO-POSTMERGE-FREEZE](COMPONENT-LOO-POSTMERGE-FREEZE.md)：逐项消融合并后的零付费重冻。
- [COMPONENT-LOO-PAID-RESULT](COMPONENT-LOO-PAID-RESULT.md)：逐项消融开发批结果。

## 诊断探针

一次性诊断脚本，不是回归断言，也不在 CI 中运行；先 `pnpm build`，再从仓库根用 `node docs/context-budget/<文件>` 运行。行为契约以 `test/` 为准。

- [review-probes.mjs](review-probes.mjs)：`ca1e2c4` 评审时的诊断探针。
- [nx08e-prune-probe.mjs](nx08e-prune-probe.mjs)：NX-08e 对照 A 的可裁剪旧任务规模测量。
- [nx08f-output-probe.mjs](nx08f-output-probe.mjs)：NX-08f 工具输出有界开关的数值探针。
- [nx17-gate-probes.mjs](nx17-gate-probes.mjs)：命令闸门的诊断矩阵。
- [nx24-replay-probe.mjs](nx24-replay-probe.mjs)：把历史 Bash 调用重放到当前闸门。
- [nx38-ledger-probe.mjs](nx38-ledger-probe.mjs)：NX-38 判据载体被裁剪或压缩后结局是否分叉的离线读数。
