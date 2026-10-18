# mini-DSH：五分钟项目讲解

本页是讲解提纲；完整安装、配置和命令说明以 [README](../README.md) 为准。项目是单 Agent、单本地工作区的 TypeScript / Cordis 编程 Harness，目标是让编辑、验证、预算停止与恢复留下可检查的事件证据。

## 五分钟演示顺序

1. **约 1 分钟：定位。** 打开 [README](../README.md) 的架构图和[实现入口](../README.md#实现入口)，说明生产 CLI 和评测入口共用 [createHarness](../src/app/create-harness.ts)。
2. **约 1 分钟：查看有效配置。** 在已按 README 安装依赖并构建的仓库运行 `node dist/src/index.js --show-config`。指出配置值及来源、工作区、预算；无需 API key，不发模型请求。已有 `MINI_DSH_SESSION_ID` 时应先移除该环境变量，或在交互会话用 `/budget` 查看恢复会话。
3. **约 2 分钟：脚本化机制演示。** 运行 `pnpm demo:compact`，依次看压缩前后请求投影、事件仍保留、`read_history` 回读。脚本使用预设模型响应；它证明 Harness 路径可演示，不代表真实模型完成编程任务。演示最后会打印生成的 `events.jsonl` 路径。
4. **约 1 分钟：检查日志。** 将上一步打印的路径填入 `$log`，运行 `node dist/src/index.js inspect $log --trace`。指出完整性、最近一次 run 状态、usage 和有限事件轨迹；`inspect` 不执行日志里的工具，也不恢复会话。若时间允许，再运行 `pnpm demo:fix` 看脚本化编辑与公开检查。

以上演示命令无需模型密钥；依赖首次安装可能访问包注册表。`pnpm start` 或已安装的 `mini-dsh` 进入交互模式时需要 `DEEPSEEK_API_KEY`，实际对话可能产生费用。本地 tarball 安装已在 Windows 验证，npm 尚未发布；其他平台的安装未验证。

## 三项有证据支持的工程贡献

以下描述的是仓库中的实现，不推断个人独立贡献；代码归属用于简历前须由用户确认。

1. **可恢复事件链与只读检查。** [event-store.ts](../src/core/event-store.ts)、[session-runtime.ts](../src/core/session-runtime.ts) 保存并重建 JSONL 状态；[session-inspect.ts](../src/core/session-inspect.ts) 对已有日志做有界、脱敏的只读汇总。可用上面的 `inspect` 演示，故障边界见 [README](../README.md#只读检查会话日志)。
2. **预算与上下文投影。** [agent-loop-runtime.ts](../src/core/agent-loop-runtime.ts)、[compaction-runtime.ts](../src/core/compaction-runtime.ts) 管理请求前预留、主动摘要和停止；[history-read.ts](../src/core/history-read.ts) 从原始事件回读。`demo:compact` 可直接展示投影变小而历史未删除。
3. **有界工具和版本化验证。** [files.ts](../src/tools/files.ts)、[bash.ts](../src/tools/bash.ts) 实现文件/命令闸门；[task-verification.ts](../src/core/task-verification.ts) 将公开检查证据绑定到候选文件版本。`demo:fix` 展示顺利路径；更多失败边界见[设计取舍](context-budget/DECISIONS.md)。

## 三个关键取舍

- **稳定前缀与规则新鲜度：** frozen 会话复用保存的时间及规则快照，帮助保持提示前缀稳定；磁盘规则更新需新会话或 `/reset` 才进入系统提示，`project_context` 仍读取当前文件。生产默认 live。见 [README](../README.md#生产配置与-v21-对照)。
- **预算停止与产物验收：** token 等预算触顶会停止调度，即使退出候选通过独立验收，也不记为“可靠完成”。[NX-45 公开证据摘要](context-budget/NX-45-PUBLIC-EVIDENCE.md)分别列出两种口径。
- **严格回放与环境动态字段：** 原录制请求和回放请求做指纹比较；限定的 Bash 工作区根和 `durationMs` 可在比较副本中归一化，命令与输出等仍严格比较。原录制保持不变。见 [NX-44 回放复盘](context-budget/NX-44-REPAIR-REPLAY.md)。

## 已知限制

- 单 Agent、单本地工作区；应用层路径和命令闸门不等于操作系统隔离。
- 本地安装仅在 Windows 验证；npm 未发布。真实交互需要模型密钥，零付费演示使用脚本化响应。
- [NX-45](context-budget/NX-45-PUBLIC-EVIDENCE.md) 是已曝光开发集。Full 的费用估价更低，但可靠完成为 10/12，Baseline 为 11/12；不能声称可靠完成率或泛化提升，也不能将组合策略结果单独归因于稳定前缀或主动压缩。公开仓库只有脱敏摘要，原始事件目前仅本地保存。

## 简历描述草案（个人贡献归属待用户确认）

- 参与构建 TypeScript / Cordis 本地编程 Agent Harness，串联事件持久化、会话恢复、工具调用与只读日志检查；**个人负责范围待确认**。
- 实现或参与实现预算约束下的请求投影、摘要和历史回读，使离线演示可展示上下文缩减与原始事件保留；**个人负责范围待确认**。
- 参与设计开发集对照的冻结协议、独立产物验收及 usage 离线更正，分别报告可靠完成、产物验收和历史价格估价；**个人负责范围待确认**。
