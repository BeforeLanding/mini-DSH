# 记忆与协作的独立开发协议

本专题与 PR #6 的 full/no-preview/no-projection/no-report 四臂及其 48 条消融分开。原负结果、指标口径和 `postCompactionPrune` 默认关闭保持其原有结论。

新协议 `memory-team-development-v1` 为开发准备：single-memory-off / single-memory-on / team-memory-off / team-memory-on；W01 知识复用、W02 旧知识失效、W03 并行调查、W04 简单任务及误导经验负对照，共 4 工作流 × 4 条件 = 16 个拟议开发目标 episode。它们是公开蓝图，尚无独立隐藏验收器，不能作为正式能力测量。

四条件共享模型选择、生产输入/输出配置、完整根任务预算、公开准备原文和工作流集合；memory-on 仅增加预先批准索引的 recall 权限，目标阶段不批准/抽取新记录。所有组均可从公开 preparation 数据读取同一来源。后续实际执行必须把准备、记忆处理、所有子 Agent、摘要、重试和汇总全部计入成本；不得按 Agent 数扩大额度。

当前命令只负责冻结和零模型 validate-only，没有付费执行路径，manifest 明示 `paidExecutionAuthorized=false`、`amountCapUsd=null`。从干净 HEAD 运行：

```powershell
pnpm eval:memory-team --freeze .eval-evidence/memory-team-dev-YYYYMMDD
pnpm eval:memory-team --validate-only .eval-evidence/memory-team-dev-YYYYMMDD
```

冻结四份 manifest；提交 SHA、源码指纹（Git 枚举 src/scripts/配置，正文按 LF 规范化）、准备数据与工作流 SHA-256 共同固定来源。验证实际装配四种 createHarness，拒绝重复臂、不同总预算、来源变化、付费/正式标记，并确认模型派发数为 0。代码或数据变化后重新冻结；纯文档证据提交不会伪装成源码变化。

进入真实开发批次前仍需：独立目标验收、逐工作流准备/目标两阶段执行器、固定 provider 版本与价格快照、美元金额上限及用户授权。原提案正式 16 工作流 × 4 条件 × 2 次重复的 128 个目标 episode 尚未构建或执行；开发观察不能追溯变为正式证据。

报告需同时展示可靠完成/独立验收、基础设施与未知用量、请求/工具/token、完整工作流成本、用户等待时间、所有 Agent 主动时间之和、过期记忆拒绝、结果采用及协作开销。预览评价信息保留和行为，投影/报告缓存评价 CPU/I/O；不把总耗时单一差异当价值结论。默认开启需要真实证据，本实现保持默认关闭。
