# 架构

mini-DSH 是用 TypeScript ESM 编写、基于 Cordis 插件的编程 Agent Harness。核心在边界上可替换：CLI、模型 provider、工具和 MCP server 都是插件或适配器。

## 事件溯源会话

- `src/core/event-store.ts` 把每条事件追加到 `events.jsonl`，并在契约要求持久化时等待磁盘写入完成。
- `src/core/contracts.ts` 定义事件联合类型；`src/core/event-validation.ts` 在运行时校验 payload。
- `src/core/session-runtime.ts` 重建可见状态、派生消息，并为每次 run 封存一条终止事件 `run/finish`。
- 每条已记录的 `tool_call` 都会得到结果，包括 `skipped`、`unknown` 或已取消。恢复时绝不重新执行结果未知的工具。

## 请求投影与压缩

- `src/core/context-runtime.ts` 按任务分组历史，保护当前任务，只在投影放不下时移除已完成的旧任务。
- `src/core/compaction-plan.ts` 在当前任务内规划一段连续影子区间；原始事件永不删除。
- `src/core/compaction-runtime.ts` 向模型请求结构化摘要，将其持久化，并插入一个由代码生成的、带有覆盖事件区间的框架事件。`read_history` 支持按事件号有界回读。
- 三个阈值都有明确名称：硬性输入上限、压力触发线（压缩预算的 0.8）和压缩后目标（0.65）。若压力压缩没有达到目标，或输入几乎没减少，本次 run 会抑制后续压力尝试并记录 `context/pressure-suppressed`；溢出兜底仍然可用。

## 模型、重试与预算

- `src/models/deepseek.ts` 是 provider 适配器。它把失败归类为有界的 `ProviderError` 类型，绝不在错误中保存响应正文或响应头。
- `src/core/model-dispatch.ts` 为每次尝试把关；`src/core/run-budget-runtime.ts` 结算请求、主动时间、token、审批和取消。
- `src/core/model-error.ts` 与 `run/error` 事件让失败阶段和安全消息对 `inspect` 可见。缺失的 usage 记为 `unknown`，绝不当成 0。
- `src/core/token-calibration.ts` 只根据 provider usage 观察估算误差，并让可选的校准层保持保守（乘数 ≥ 1）。

## 工具与审批

- `src/core/tool-runtime.ts` 在工具主体运行前，让每个工具都经过同一个集中授权钩子。
- `src/core/tool-authorization.ts` 只信任声明效果与注册表一致的内置工具。未知或外部工具一律询问；审批绑定到工具调用、参数摘要、工作区和策略版本。
- 文件工具在审批前后都做真实路径和软链检查。Bash 使用显式构造的子进程环境和一个独立的临时 HOME。这是应用层策略，不是操作系统隔离。

## MCP

- MCP 默认关闭且为空（`src/app/mcp-config.ts`）。它只加载用户级配置或显式路径，密钥只接受 `${ENV_NAME}` 引用，绝不自动加载工作区配置。
- MCP 工具以 `serverName` 命名空间区分，按未知效果工具处理，并通过同一个 `ToolRuntime` 注册。连接失败、超时和断连都局限在该 server 内。
- stdio server 由 MCP SDK 启动，使用其共享的凭据名擦除规则（名称含 `KEY`/`PASSWORD`/`SECRET`/`TOKEN` 以及 `DSH_*`），而不是 Bash 的严格白名单；代理、SSH agent 变量、`NODE_OPTIONS` 和真实 HOME 仍可能被继承。配置一个 server 就是一次明确的信任决定。

## 隔离与证据

- `scripts/eval-v2-isolation.ts` 在同一接口后提供两个后端：Windows 上的 WSL→bwrap，以及 Linux 原生 bwrap。预检会验证命名空间、无网络接口、工作区可写、主机路径被隐藏以及后代进程终止。
- 必需的 CI 隔离 job 会安装 bubblewrap、准备固定版本的 Node 运行时，并在任何必需的测试被跳过时失败。
- `scripts/recompute-report.ts` 校验 `SHA256SUMS`，从 `events.jsonl` 重建 `report.json`，并与 `docs/RESULTS.md` 比较。合成样例与能力主张相互独立。

## 安装后的 CLI

`mini-dsh` 提供 `--help`、`--version`、`--show-config`、`inspect` 和离线的 `demo [fix]`。交互式使用需要 `DEEPSEEK_API_KEY`；`demo`、`inspect` 和 `--show-config` 不需要。
