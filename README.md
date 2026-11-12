# mini-DSH

[![CI](https://github.com/BeforeLanding/mini-DSH/actions/workflows/ci.yml/badge.svg)](https://github.com/BeforeLanding/mini-DSH/actions/workflows/ci.yml)

> 在本地代码仓库中运行的命令行编程 Agent：每次修改、检查和中断恢复都留下可复查的证据。

![预算停止后在同一任务续跑，没有工具被执行两次](docs/images/demo-resume.gif)

用自然语言提出任务，Agent 读取项目规则、定位代码、编辑文件并运行检查；你审批写入与命令，查看 diff 与验证记录，预算触顶或进程崩溃后可从原任务继续。TypeScript / Cordis 构建，内置 DeepSeek 适配器。

- **SWE-bench Verified 90 题：** 打开长单任务组件后解决 74 题，同模型、同 token 上限下 mini-SWE-agent 为 57 题，不开组件为 61 题；代价约 2.6 倍成本，见[评测](#评测)。
- **崩溃安全的恢复：** 会话写入 JSONL 事件链，可重建状态并续跑；结果未知的工具不会被自动重跑。
- **多 Agent 编排：** 每个 worker 在独立 git worktree 中执行，宿主检查写集、按序整合并复验。

[快速开始](#快速开始) · [使用指南](docs/USAGE.md) · [架构](docs/ARCHITECTURE.md) · [五分钟讲解](docs/RECRUITER_WALKTHROUGH.md)

## 快速开始

需要 **Node.js ≥ 22、pnpm 11.22.0 和 Bash**（Windows 使用 Git for Windows 自带的 Bash）。也可安装 [v0.3.0 Release](https://github.com/BeforeLanding/mini-DSH/releases/tag/v0.3.0) 附带的 tarball，见[使用指南](docs/USAGE.md#本地打包与安装)。

```shell
git clone https://github.com/BeforeLanding/mini-DSH.git
cd mini-DSH
pnpm install --frozen-lockfile
pnpm build
node dist/src/index.js demo fix   # 离线演示，无需 API key，结束时输出 demo result: PASS
```

接入真实模型：把 `.env.example` 复制为 `.env`（已有则保留），填写 `DEEPSEEK_API_KEY`；要操作其他项目再设置 `MINI_DSH_WORKSPACE`。然后运行 `pnpm start`，看到 `User >` 后输入任务。写文件、编辑文件和执行 Bash 默认需要审批；真实模型调用会产生 API 费用。

常用命令：`/diff` 与 `/report` 查看修改和验证证据，`/budget` 与 `/continue` 查看预算并续跑，`/compact` 压缩历史，`/exit` 退出。完整说明见[使用指南](docs/USAGE.md)。

## 核心设计

- **按项目约定工作。** 编辑前加载作用域内的 `AGENTS.md` 和项目检查入口。
- **证据绑定文件版本。** 编辑用版本指纹检测冲突；检查记录关联文件版本，文件之后再变，证据即标为过期；`/report` 区分通过、失败、过期和未知。
- **长任务上下文。** 有界读取与搜索，长输出按引用回读；压缩只作用于请求投影，原始事件保留并可按事件号回读。
- **预算受控。** 模型请求、工具次数、时间和 token 均可配置；触顶时停止调度并报告原因。
- **恢复与只读检查。** 从 JSONL 重建状态、续跑符合条件的任务；`inspect` 在不请求模型的情况下汇总日志。
- **多 Agent 编排。** `mini-dsh orchestrate run` 校验计划后为每个 worker 建立独立 Harness 和 worktree，宿主确定性 cherry-pick 整合，复验证据绑定 tree SHA；`resume` 采用已完成结果而不重跑，未知副作用与冲突交给人决定。见[使用指南](docs/USAGE.md#多-agent-编排)。

## 演示

以下脚本用预设模型响应驱动真实的 Harness 路径，无需 API key：

| 命令 | 展示内容 |
| --- | --- |
| `pnpm demo:fix` | 读规则、定位、编辑、失败检查、再修复、diff 与验证证据 |
| `pnpm demo:resume` | 预算停止后在同一任务续跑 |
| `pnpm demo:compact` | 压缩、原始事件保留与按事件号回读 |
| `pnpm demo:unknown` | 真实崩溃后的未知工具结果与陈旧锁处置 |
| `pnpm demo:orchestrate-parallel` | 两个 worker 并行，第二波次读取整合后的依赖产物 |
| `pnpm demo:orchestrate-crash` | worker 崩溃后 `resume` 不重跑已完成结果 |

## 评测

在 90 道未参与调参的 SWE-bench Verified 题上，打开长单任务组件的 mini-DSH 解决 74 题；同模型（`deepseek/deepseek-flash`）、同环境、同 token 上限下，mini-SWE-agent 解决 57 题，同源码但不开组件的 mini-DSH 解决 61 题。代价是成本约为 mini-SWE-agent 的 2.6 倍；没有做逐项消融，差距不能归给单个组件。这些组件在 main 上默认关闭，开关见[使用指南](docs/USAGE.md#长单任务的可选组件)。设置、配对检验与限制见 [SWE-bench 结果](docs/SWE-BENCH-RESULTS.md)。

多 Agent 编排的真实模型第一批因对照条件不对称，不能说明编排优于单 Agent，见[编排结果](docs/superagent/RESULTS-20261108.md)。

## 架构

![mini-DSH 架构：入口与装配、Agent Loop、上下文管理、模型与工具、事件日志及其派生的恢复、检查与交付证据](docs/images/architecture.png)

CLI、模型、工具与 MCP 通过 Cordis 插件和服务契约装配；生产入口与评测入口共用 [createHarness](src/app/create-harness.ts)。JSONL 记录会话事实，上下文投影与统计从事件派生。

```text
src/
├── index.ts         # CLI 启动入口
├── app/             # Harness 装配、配置、离线演示
├── core/            # Agent Loop、事件日志、恢复、上下文与预算
├── orchestration/   # 多 Agent 计划、worktree、整合与恢复
├── plugins/         # 把运行能力注册为 Cordis 服务
├── models/          # 模型适配器（DeepSeek 流式协议）
└── tools/           # 文件读写、搜索、Bash、变更与验证报告
```

详细设计见[架构说明](docs/ARCHITECTURE.md)、[设计取舍](docs/context-budget/DECISIONS.md)和[工程案例](docs/CASES.md)。

## 已知边界

- 路径与命令闸门是应用层策略，不是操作系统隔离；Bash 可访问当前用户有权限的文件。
- `/diff` 只覆盖文件工具的修改，Bash 的改动请结合 Git 查看；恢复重建事件状态，不还原文件快照。
- token 为估算值，执行预算不等于费用硬上限。
- 以 GitHub Release 提供 tarball，尚未发布 npm；macOS 安装未验证。

## 开发

```shell
pnpm check   # strict 类型检查、构建与产物语法检查
pnpm test    # 核心与 Cordis 集成回归，无需模型密钥
```

CI 覆盖 Ubuntu / Windows × Node.js 22 / 24，另含 Linux bubblewrap 隔离测试和仓库外安装检查。修改前阅读 [AGENTS.md](AGENTS.md)；开发记录见[文档索引](docs/README.md)与 [PROGRESS](PROGRESS.md)。

## 来源与许可

起点是教程[从零手写 mini-dsh](https://github.com/huangjunsen0406/mini-dsh/blob/main/LEARNING.zh-CN.md)，止于 `c5fc9c4`：当时为约 1,250 行 JavaScript 的最小 Agent Loop、DeepSeek 适配器与文件/Bash 工具。`43e3829` 起为本项目独立扩展：迁移到 strict TypeScript，并新增事件持久化与恢复、上下文与预算、版本化验证、只读检查、多 Agent 编排和评测通道，`src/` 现约 1.08 万行。许可证与来源说明见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
