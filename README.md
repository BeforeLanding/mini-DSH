# mini-DSH

[![CI](https://github.com/BeforeLanding/mini-DSH/actions/workflows/ci.yml/badge.svg)](https://github.com/BeforeLanding/mini-DSH/actions/workflows/ci.yml)

mini-DSH 是一个 TypeScript / Cordis 编写的本地编程 Agent Harness。它把读项目规则、定位代码、可靠编辑、运行公开检查、交付 diff 与验证证据串成可恢复的任务流程；用事件日志、上下文投影、预算和工具审批说明每一步发生了什么。它面向单 Agent、单本地工作区，路径/命令闸门是应用策略，不是操作系统隔离。

仓库的教程基线来自[从零手写 mini-dsh](https://github.com/huangjunsen0406/mini-dsh/blob/main/LEARNING.zh-CN.md)，止于 `c5fc9c4`；`43e3829` 起是本项目的独立扩展。

![当前架构：入口、Agent Loop、模型、工具、事件与恢复](docs/images/architecture-v1.png)

## 五分钟上手

需要 Node.js ≥ 20.18.1、pnpm 11.22.0。Windows 的 Bash 工具使用 Git for Windows；Linux/macOS 使用 PATH 中的 `bash`。以下命令不需要 API key，不发出模型请求：

```powershell
pnpm install --frozen-lockfile
pnpm check
node dist/src/index.js --show-config
pnpm demo:compact
```

`--show-config` 只读装配同一个 Harness，输出**新会话**实际配置及来源（环境、`.env`、默认或 provider 容量），包括模型、布局、工具预览、预算和 `read_history`；不打印密钥、环境变量全集、项目规则正文，也不创建 CLI 会话。非法配置直接报错。若设置了 `MINI_DSH_SESSION_ID`，它拒绝把新会话配置冒充恢复会话的配置；恢复后用 CLI `/budget` 查看预算。`pnpm demo:compact` 使用脚本化模型演示单任务摘要、原始事件保留及 `read_history` 按事件号回读。完整离线回归可运行 `pnpm test`（会在本机执行 Bash 和文件工具）。

接入真实模型需先在 `.env` 填写 `DEEPSEEK_API_KEY`，再运行 `pnpm start`；**后续 CLI 对话可能产生模型费用**。不要覆盖已有 `.env`：

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# 在 .env 中填写 DEEPSEEK_API_KEY
pnpm start
```

## 演示

上面的 `pnpm demo:compact` 是零付费机制演示：脚本化摘要缩小当前任务的请求投影，事件日志仍保留原文，并通过 `read_history` 回读。想看编辑、检查、失败后修复及交付证据的完整编程流程，可运行同样使用脚本化模型的 `pnpm demo:fix`。

## 生产配置与 v2.1 对照

生产入口 [src/index.ts](src/index.ts) 调用共用的 [createHarness](src/app/create-harness.ts)，评测入口也调用它；没有另复制一套 Harness。日常默认是 `coding`、`contextLayout=live`、16 KiB 工具结果预览，以及 [CLI_BUDGET](src/core/budget.ts) 的输入目标 65,536 token、主动压缩比例 0.8、一次溢出兜底、每段 2M 累计 token 上限。`read_history` 默认可用；它按事件号读取保留的原始历史，不是主动压缩开关。

- `MINI_DSH_CONTEXT_LAYOUT=live|frozen` 只控制运行时钟和项目上下文在系统提示里的文本是否固定，用于稳定前缀。默认 `live`；非法值拒绝。它**不是**完整 Full 配置。
- `MINI_DSH_TOOL_PREVIEW_BYTES` 控制有界工具结果进入模型历史的预览大小，默认 16,384 字节；超长结果可用 `read_tool_result` 回读。必须是正安全整数。
- `MINI_DSH_BUDGET` 沿用 CLI 的 JSON 预算配置，可调整输入目标、主动压缩、调用/工具/token/时间上限；`/budget` 查看当前会话的有效预算。溢出兜底与主动压缩是两条路径，关闭或推迟主动压缩不会自动关闭兜底。
- `MINI_DSH_PROFILE`、`MINI_DSH_WORKSPACE`、`MINI_DSH_PROJECT_DIRECTORY` 沿用既有配置；项目目录只决定初始规则上下文，不更改文件/Bash 工作区。

在冻结的 v2.1 开发协议中，Full 同时使用 frozen 前缀、65,536 输入目标的主动压缩和 16 KiB 有界预览；Baseline 使用 live 前缀、1M 输入/压缩目标和大预览（实现为 64 MiB 上限）。两臂都保留溢出兜底与 `read_history`，还共享模型、工具及整题预算。生产默认与任一实验臂均不能仅按 `contextLayout` 等同；[协议](docs/context-budget/NX-45-DEVELOPMENT.md)列出完整配置。

**frozen 的生命周期限制：** `Time:` 在该 Harness 第一次组装系统提示时取值；项目规则也在第一次组装时形成系统提示快照，持续到该 Harness 释放。CLI 中新建/重置会话不会刷新快照；若工作区 `AGENTS.md` 或项目配置变化，需重启 CLI 才能更新系统提示。`project_context` 工具仍实时读盘，可查询新规则，但它不会改写已经冻结的系统提示。经常修改规则的工作区宜保留默认 live；本项目未实现规则热更新。

## 实现入口

- [src/core/agent-loop-runtime.ts](src/core/agent-loop-runtime.ts)：请求投影、主动压缩和预算停止；[src/core/compaction-runtime.ts](src/core/compaction-runtime.ts)：摘要调用与结算。
- [src/core/session-runtime.ts](src/core/session-runtime.ts) 与 [src/core/event-store.ts](src/core/event-store.ts)：JSONL 事件、恢复和统计重建。
- [src/tools/files.ts](src/tools/files.ts)、[src/tools/bash.ts](src/tools/bash.ts)：有界读写、命令和验证证据；[src/plugins/tool-results.ts](src/plugins/tool-results.ts)、[src/plugins/read-history.ts](src/plugins/read-history.ts)：结果与历史回读。
- [src/models/deepseek.ts](src/models/deepseek.ts)：流式模型适配和 provider usage。配置入口在 [src/app/production-config.ts](src/app/production-config.ts)，无密钥查看在 [src/app/config-inspection.ts](src/app/config-inspection.ts)。

## NX-45 开发探索的边界

六道**已曝光开发题**、每臂计划分母 12、每题两次。Baseline/Full 的可靠完成为 **11/12 对 10/12**，独立产物验收为 **11/12 对 12/12**。Full 的峰时 provider usage 估价更低（$0.391956600 对 $1.448544408），但请求、工具调用和主动时间更多。费用是按冻结价格重算的估价，**不是供应商账单**。本批没有证明可靠完成率提高、统计显著性或泛化优势；组合配置的费用差异不能全归因于单一机制。逐题结果、模型版本、固定预算和末尾轨迹见 [探索报告](docs/context-budget/NX-45-EXPLORATION-RESULT.md)，原始 usage 更正与哈希见 [更正说明](docs/context-budget/NX-45-USAGE-CORRECTION.md)。

更多设计与验收入口：[需求](docs/context-budget/REQUIREMENTS.md)、[计划](docs/context-budget/PLAN.md)、[任务清单](docs/context-budget/TASKS.md)、[进度](PROGRESS.md)。
