# mini-DSH：五分钟项目讲解

本页是讲解提纲，只讲工程线索与取舍；模型评测见 [SWE-bench 三臂对照](SWE-BENCH-RESULTS.md)；编排四臂第一批见[结果页](superagent/RESULTS-20261108.md)，它不支持“编排更好”的结论；项目介绍见 [README](../README.md)，完整安装、配置和命令说明见 [使用指南](USAGE.md)。主分支以单 Agent 操作单个本地工作区，目标是让编辑、验证、预算停止与恢复留下可检查的事件证据。多 Agent 编排（M1–M4）已合入 main，随 v0.3.0 发布；其契约与离线证据见 [docs/superagent](superagent/DEVELOPMENT.md)。

## 五分钟演示顺序

1. **约 1 分钟：定位。** 打开 [README](../README.md) 的架构图和[实现入口](../README.md#实现入口)，说明生产 CLI 和评测入口共用 [createHarness](../src/app/create-harness.ts)。
2. **约 1 分钟：查看有效配置。** 在已按 README 安装依赖并构建的仓库运行 `node dist/src/index.js --show-config`。指出配置值及来源、工作区、预算；无需 API key，不发模型请求。已有 `MINI_DSH_SESSION_ID` 时应先移除该环境变量，或在交互会话用 `/budget` 查看恢复会话。
3. **约 2 分钟：脚本化机制演示。** 运行 `pnpm demo:compact`，依次看压缩前后请求投影、事件仍保留、`read_history` 回读。脚本使用预设模型响应；它证明 Harness 路径可演示，不代表真实模型完成编程任务。演示最后会打印生成的 `events.jsonl` 路径。
4. **约 1 分钟：检查日志。** 将上一步打印的路径填入 `$log`，运行 `node dist/src/index.js inspect $log --trace`。指出完整性、最近一次 run 状态、usage 和有限事件轨迹；`inspect` 不执行日志里的工具，也不恢复会话。若时间允许，再运行 `pnpm demo:fix` 看脚本化编辑与公开检查。
5. **可选：编排演示。** 在 main 上运行 `pnpm demo:orchestrate-parallel`：只读 planner 生成两波次计划，两个 worker 的区间重叠，第三个任务在第二波次读取整合后的依赖；演示最后用工作区之外的隐藏验收器复验。再运行 `pnpm demo:orchestrate-crash` 看 `resume` 不重跑已完成结果、未知副作用需要人工决定。两者都是脚本模型，不发真实请求。

以上演示命令无需模型密钥；依赖首次安装可能访问包注册表。`pnpm start` 或已安装的 `mini-dsh` 进入交互模式时需要 `DEEPSEEK_API_KEY`，实际对话可能产生费用。本地 tarball 安装已在 Windows 验证，Linux 由 CI 的 `package-install` job 验证，npm 尚未发布；macOS 安装未验证。

## 三项有证据支持的工程贡献

1. **可恢复事件链与只读检查。** [event-store.ts](../src/core/event-store.ts)、[session-runtime.ts](../src/core/session-runtime.ts) 保存并重建 JSONL 状态；[session-inspect.ts](../src/core/session-inspect.ts) 对已有日志做有界、脱敏的只读汇总。可用上面的 `inspect` 演示，故障边界见 [使用指南](USAGE.md#只读检查会话日志)。
2. **预算与上下文投影。** [agent-loop-runtime.ts](../src/core/agent-loop-runtime.ts)、[compaction-runtime.ts](../src/core/compaction-runtime.ts) 管理请求前预留、主动摘要和停止；[history-read.ts](../src/core/history-read.ts) 从原始事件回读。`demo:compact` 可直接展示投影变小而历史未删除。
3. **有界工具和版本化验证。** [files.ts](../src/tools/files.ts)、[bash.ts](../src/tools/bash.ts) 实现文件/命令闸门；[task-verification.ts](../src/core/task-verification.ts) 将公开检查证据绑定到候选文件版本。`demo:fix` 展示顺利路径；更多失败边界见[设计取舍](context-budget/DECISIONS.md)。

## 多 Agent 编排

同一根任务内、宿主驱动的多写入者闭环：计划校验 → 每个 worker 一个独立 Harness + git worktree → 宿主提交与写集检查 → 按序 cherry-pick 整合 → 整合后复验。三项有代码与测试证据的贡献（均不等于模型能力结论）：

1. **根任务账本不因崩溃把未知用量当作 0。** 同一个预留-派发-结算状态机既服务只读委派（会话日志），也服务多写入者编排（独立编排日志）；崩溃后保留 unknown 用量并要求人工确认，429 只释放预留并共享冷却。[task-group-budget.ts](../src/core/task-group-budget.ts)、[group-journal.ts](../src/orchestration/group-journal.ts)。
2. **宿主确定性整合。** 写集事后强制、按序 cherry-pick、冲突即停并转人工决定、整合后复验且证据绑定 tree SHA；用户工作树 HEAD/状态不变。[integrator.ts](../src/orchestration/integrator.ts)、[verifier.ts](../src/orchestration/verifier.ts)。
3. **attempt 级恢复。** `resume` 采用已完成的 worker 结果而不重跑（provider 调用数不增加），整合按记录基线重置后重放；未知副作用与冲突转人工决定。[recovery.ts](../src/orchestration/recovery.ts)、[faults.ts](../src/orchestration/faults.ts)。

离线证据：`pnpm demo:orchestrate-single` / `-parallel` / `-crash`，以及 `pnpm eval:orchestrate --validate-only`（组合夹具正反例 + S/D/R/R-serial 四臂装配，provider 请求为 0）。真实模型第一批已执行：编排臂 4/4、单 Agent 臂 2/4，但差异来自夹具规格只写在固定计划里、以及两类臂的提示缓存配置不同，[结果页](superagent/RESULTS-20261108.md)写明了这些混杂；不要把它说成已验证的效率或成功率提升。

## 三个关键取舍

- **稳定前缀与规则新鲜度：** frozen 会话复用保存的时间及规则快照，帮助保持提示前缀稳定；磁盘规则更新需新会话或 `/reset` 才进入系统提示，`project_context` 仍读取当前文件。生产默认是项目上下文 `live`、运行时钟 `frozen`，两者不是同一个开关。见 [使用指南](USAGE.md#生产配置与-v21-对照)。
- **预算停止与产物验收：** token 等预算触顶会停止调度，即使退出候选通过独立验收，也不记为“可靠完成”。[NX-45 公开证据摘要](context-budget/NX-45-PUBLIC-EVIDENCE.md)分别列出两种口径。
- **严格回放与环境动态字段：** 原录制请求和回放请求做指纹比较；限定的 Bash 工作区根和 `durationMs` 可在比较副本中归一化，命令与输出等仍严格比较。原录制保持不变。见 [NX-44 回放复盘](context-budget/NX-44-REPAIR-REPLAY.md)。

## 已知限制

- 默认仍是单 Agent、单本地工作区；应用层路径和命令闸门不等于操作系统隔离。多 Agent 编排需显式运行 `orchestrate`，其真实模型四臂第一批的结论是“不能说明编排更好”。
- 本地 tarball 安装在 Windows 验证，Ubuntu 由 CI 的仓库外安装 job 验证；macOS 未验证；以 GitHub Release 提供 v0.3.0 tarball，npm 未发布。真实交互需要模型密钥，零付费演示使用脚本化响应。
- SWE-bench 三臂对照的结论须连同约 2.6 倍成本与未做逐项消融一起陈述，见 [SWE-BENCH-RESULTS](SWE-BENCH-RESULTS.md)。编排四臂第一批不支持“编排更好”，混杂因素见[结果页](superagent/RESULTS-20261108.md)。更早的开发集探索不构成可靠完成率或泛化提升，也不能把组合策略结果单独归因于稳定前缀或主动压缩；公开仓库只有脱敏摘要，原始事件仅本地保存。协议边界见 [EVALUATION-SWEBENCH](EVALUATION-SWEBENCH.md)。

## 简历描述草案

- 构建 TypeScript / Cordis 本地编程 Agent Harness，实现事件持久化、崩溃恢复与只读日志检查；恢复时区分 `skipped` / `unknown`，不重放可能已产生副作用的工具。
- 实现预算约束下的请求投影、上下文压缩与按事件号回读；压缩不删除原始事件，离线演示可复算投影缩减与原文保留。
- 设计开发集对照的冻结协议、独立产物验收与 usage 口径，把完成、验收和成本分开报告，不把机制证据当作成功率。
- 实现宿主驱动的多 Agent 编排（v0.3.0 起发布）：独立 worktree 并行执行、写集检查、确定性整合与整合后复验；崩溃恢复采用已完成结果而不重跑，未知用量需人工确认。离线演示与四臂装配通过；真实模型第一批已执行，结论是“不能说明编排更好”，见[结果页](superagent/RESULTS-20261108.md)。
