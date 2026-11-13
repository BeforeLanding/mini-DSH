# mini-DSH

[![CI](https://github.com/BeforeLanding/mini-DSH/actions/workflows/ci.yml/badge.svg)](https://github.com/BeforeLanding/mini-DSH/actions/workflows/ci.yml)

mini-DSH 是一个在本地代码仓库中运行的命令行编程 agent（智能体）。它用 TypeScript 编写，构建于 [Cordis](https://github.com/cordiverse/cordis) 插件系统之上，内置 DeepSeek 模型适配器。

会话保存为追加式的 JSONL 事件日志。进程崩溃或预算耗尽后，可以从日志重建状态，在原任务上继续；结果未知的工具调用不会被自动重跑。

文档：[使用指南](docs/USAGE.md) · [架构](docs/ARCHITECTURE.md) · [文档索引](docs/README.md)

![预算停止后在同一任务续跑，没有工具被执行两次](docs/images/demo-resume.gif)

## 项目状态

mini-DSH 是个人项目，不是 DeepSeek 官方项目，也不依赖 `@deepseek-ai/dsh`。它仍在迭代，配置项和命令可能变化。当前版本为 [v0.3.0](https://github.com/BeforeLanding/mini-DSH/releases/tag/v0.3.0)，尚未发布到 npm。

路径与命令闸门是应用层策略，不是操作系统隔离。在重要的仓库上运行之前，请先阅读[已知边界](#已知边界)。

## 运行

需要 Node.js 22 或更高版本、pnpm 11.22.0 和 Bash。Windows 上使用 Git for Windows 自带的 Bash。

### 离线演示

```sh
git clone https://github.com/BeforeLanding/mini-DSH.git
cd mini-DSH
pnpm install --frozen-lockfile
pnpm build
node dist/src/index.js demo fix
```

演示用预设的模型响应驱动真实的 harness 路径，不需要 API key，结束时打印 `demo result: PASS`。其余演示：

| 命令 | 内容 |
|---|---|
| `pnpm demo:fix` | 读规则、定位、编辑、检查失败后再修复，最后查看 diff 和检查记录 |
| `pnpm demo:resume` | 预算停止后在同一任务上继续 |
| `pnpm demo:compact` | 压缩历史，原始事件保留，可按事件号回读 |
| `pnpm demo:unknown` | 进程崩溃后，结果未知的工具调用与陈旧锁如何处置 |
| `pnpm demo:orchestrate-parallel` | 两个 worker 并行，第二波次读取整合后的产物 |
| `pnpm demo:orchestrate-crash` | worker 崩溃后，`resume` 不重跑已完成的结果 |

### 接入 DeepSeek

把 `.env.example` 复制为 `.env`（已有则保留），填写 `DEEPSEEK_API_KEY`，然后运行：

```sh
pnpm start
```

看到 `User >` 后输入任务。默认工作区是当前目录；要操作其他项目，设置 `MINI_DSH_WORKSPACE`。写文件、编辑文件和执行 Bash 默认需要审批。真实模型调用会产生 API 费用。

会话中的常用命令：

| 命令 | 用途 |
|---|---|
| `/diff`、`/report` | 查看文件改动和检查记录 |
| `/budget`、`/continue` | 查看预算；预算停止后继续同一任务 |
| `/compact` | 压缩当前任务的历史 |
| `/exit` | 退出 |

完整命令、预算配置和 Release tarball 的安装方式见[使用指南](docs/USAGE.md)。

## 评测

评测使用 90 道 SWE-bench Verified 题，这些题都没有参与调参。三组配置使用同一模型 `deepseek/deepseek-flash`、同一命令环境和同一 token 上限：mini-SWE-agent 2.4.6 解决 57 题，不开长任务组件的 mini-DSH 解决 61 题，打开组件后解决 74 题。

打开组件后，成本约为 mini-SWE-agent 的 2.6 倍。没有做逐项消融，差距不能归到某一个组件上。这些组件在 main 上默认关闭，开关见[使用指南](docs/USAGE.md#长单任务的可选组件)；设置、配对检验与限制见 [SWE-bench 结果](docs/SWE-BENCH-RESULTS.md)。

多 agent 编排的第一批真实模型运行中，两类配置的夹具与提示缓存设置不一致，结果不能说明编排优于单 agent，见[编排结果](docs/superagent/RESULTS-20261108.md)。

## 架构

CLI、模型适配器、工具和 MCP 都以 Cordis 插件的形式注册服务。生产入口、离线演示和评测共用 [`createHarness`](src/app/create-harness.ts) 完成装配。

`events.jsonl` 是会话的唯一事实来源。发给模型的请求上下文、用量统计和 `/report` 的内容都从事件派生；压缩只改变请求，不删除原始事件。

| 目录 | 职责 |
|---|---|
| `src/app/` | 装配、配置、离线演示与编排命令 |
| `src/core/` | agent loop（智能体循环）、事件日志、恢复、上下文与预算 |
| `src/orchestration/` | 多 agent 计划、worktree、整合与恢复 |
| `src/plugins/` | 把运行能力注册为 Cordis 服务 |
| `src/models/` | DeepSeek 流式协议适配器 |
| `src/tools/` | 文件读写、搜索、Bash、变更与检查报告 |

主要行为：

- 编辑文件前加载作用域内的 `AGENTS.md`。
- 编辑带文件版本指纹，用于发现冲突；检查记录绑定文件版本，文件之后再变，`/report` 会把该记录标为过期。
- 模型请求、工具调用、时间和 token 都有可配置的预算；触顶时停止调度并记录原因。
- `inspect` 只读取日志，不请求模型，也不执行日志中的工具。
- `mini-dsh orchestrate run` 为每个 worker 建立独立的 harness 和 git worktree，由宿主按序 cherry-pick 整合，再运行检查。

各部分的实现见[架构说明](docs/ARCHITECTURE.md)，主要取舍见[设计取舍](docs/context-budget/DECISIONS.md)和[工程案例](docs/CASES.md)。

## 已知边界

- 路径与命令闸门是应用层策略，不是操作系统隔离；Bash 可以访问当前用户有权限的所有文件。
- `/diff` 只覆盖文件工具做的修改，Bash 的改动需要用 Git 查看。恢复只重建事件状态，不还原文件快照。
- token 数是估算值，预算不等于费用硬上限。
- macOS 上的安装未验证。

## 开发

```sh
pnpm check   # strict 类型检查、构建与产物语法检查
pnpm test    # 核心与 Cordis 集成测试，不需要模型 API key
```

CI 覆盖 Ubuntu / Windows 与 Node.js 22 / 24，另有 Linux bubblewrap 隔离测试和仓库外安装检查。开发记录见[文档索引](docs/README.md)与 [PROGRESS](PROGRESS.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 来源

本项目起源于教程[从零手写 mini-dsh](https://github.com/huangjunsen0406/mini-dsh/blob/main/LEARNING.zh-CN.md)，沿用到提交 `c5fc9c4`：当时约 1,250 行 JavaScript，包含最小的 agent loop、DeepSeek 适配器和文件/Bash 工具。从 `43e3829` 起为独立扩展：迁移到 strict TypeScript，加入事件持久化与恢复、上下文与预算、带版本的检查记录、只读检查、多 agent 编排和评测入口。`src/` 目前约 1.08 万行。

## 许可证

[MIT](LICENSE)

来源说明见 [NOTICE](NOTICE)。
