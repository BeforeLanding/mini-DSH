# mini-DSH

[![CI](https://github.com/BeforeLanding/mini-DSH/actions/workflows/ci.yml/badge.svg)](https://github.com/BeforeLanding/mini-DSH/actions/workflows/ci.yml)

> 一个可恢复、可检查、预算受控的本地编程 Agent Harness。

mini-DSH 用 TypeScript / Cordis 从零实现了一条单 Agent、单本地工作区的编程任务流程：读项目规则、定位代码、可靠编辑、运行公开检查、交付 diff 与验证证据。它不把 Harness 做成黑盒——每一步都落成 JSONL 事件，请求投影、上下文压缩、预算停止、工具审批和崩溃恢复都能从日志复核。路径与命令闸门是应用层策略，不是操作系统隔离。

## 工程亮点

- **事件溯源会话。** [event-store.ts](src/core/event-store.ts) 把每条事件追加到 `events.jsonl` 并等待落盘；[session-runtime.ts](src/core/session-runtime.ts) 从日志重建可见状态。每个已记录的 `tool_call` 都有对应结果，包括取消或预算停止时的 `skipped`，以及开始过但结果不可知的 `unknown`；恢复只重建状态，不重放 `unknown` 工具。
- **请求投影与压缩。** [context-runtime.ts](src/core/context-runtime.ts) 按任务分组历史，只裁剪已结束且非当前的完整任务；[compaction-plan.ts](src/core/compaction-plan.ts) 规划当前任务内的连续影子区间，原始事件一条不删。[read_history](src/plugins/read-history.ts) 可按事件号回读原文。
- **有界工具与审批。** [files.ts](src/tools/files.ts)、[bash.ts](src/tools/bash.ts) 在读写与执行前做真实路径、软链和命令闸门检查；[tool-runtime.ts](src/core/tool-runtime.ts) 统一经过授权钩子。长输出每路保留 8 KiB 头与 8 KiB 尾，溢出的中间段显式标记，不会把截断文本伪装成完整结果。
- **预算与停止。** [run-budget-runtime.ts](src/core/run-budget-runtime.ts) 统一结算请求、主动时间、token、审批和取消；[agent-loop-runtime.ts](src/core/agent-loop-runtime.ts) 在每次请求前预留并在触顶时停止调度。缺失 usage 记为未知，不按零补算。
- **可检查。** [session-inspect.ts](src/core/session-inspect.ts) 对已有日志做有界、只读汇总，不恢复会话、不执行日志里的工具；完整性、终止原因、usage 和数据缺口都直接可见。
- **插件化装配。** CLI、模型、工具与 MCP 都是 Cordis 插件或适配器；生产入口 [src/index.ts](src/index.ts) 与评测入口共用 [createHarness](src/app/create-harness.ts)，没有复制第二套 Harness。

## 架构

![当前架构：入口、Agent Loop、模型、工具、事件与恢复](docs/images/architecture-v1.png)

更细的事件模型、投影、压缩、模型重试和 MCP 边界见 [ARCHITECTURE](docs/ARCHITECTURE.md)。

## 五分钟上手

需要 Node.js ≥ 22、pnpm 11.22.0。Windows 的 Bash 工具使用 Git for Windows；Linux/macOS 使用 PATH 中的 `bash`。以下命令不需要 API key，不发出模型请求：

```powershell
pnpm install --frozen-lockfile
pnpm check
node dist/src/index.js demo fix
node dist/src/index.js --show-config
```

`demo fix` 在一个临时项目里由脚本化模型完成“失败测试 → 读文件 → 修复 → 再测试”，不读 `.env`、不联网、不需要 API key，输出 `demo result: PASS`。

`--show-config` 只读装配同一个 Harness，输出**新会话**实际配置及来源（环境、`.env`、默认或 provider 容量），包括模型、布局、工具预览、预算和 `read_history`；不打印密钥、环境变量全集或项目规则正文，也不创建 CLI 会话。非法配置直接报错。若设置了 `MINI_DSH_SESSION_ID`，它拒绝把新会话配置冒充恢复会话的配置；恢复后用 CLI `/budget` 查看预算。

## 演示

- `pnpm demo:compact`：脚本化模型演示单任务摘要、请求投影缩小、原始事件保留，以及 `read_history` 按事件号回读。
- `pnpm demo:fix`：完整编程流程——项目规则、定位、编辑、失败检查、再修复、diff 与验证证据。
- `pnpm demo:resume`：预算停止后在同一 task 续跑。
- `pnpm demo:unknown`：真实崩溃后 `unknown` 工具结果与陈旧锁的处置。
- `pnpm demo:memory`、`pnpm demo:team`：记忆开关与只读协作的机制演示。

以上演示都使用脚本化响应或合成账本，不产生模型请求；退出码 0 只说明 Harness 行为符合预期，不代表模型能力。

### 只读检查会话日志

已有 `events.jsonl` 可在无 API key、无模型请求时查看。`inspect` 不恢复会话、不获取写锁，也不执行日志里的命令或工具；路径可以位于含空格的目录。

```powershell
$log = Join-Path $env:USERPROFILE '.mini-dsh\sessions\<session-id>\events.jsonl'
& $miniDsh inspect $log
& $miniDsh inspect $log --json
& $miniDsh inspect $log --trace
```

- 文本默认列出会话和最近一次 run 的状态、请求/重试/派发前拒绝、工具结果、provider token 与缓存、缺 usage、摘要及 `read_history` 次数、frozen 快照来源。
- `--trace` 只附带最近 40 条所选事件的序号、类型、工具名或终止原因；不显示提示正文和工具输出。
- `--json` 返回版本为 `1` 的结构化数据，含 `integrity.complete`、`integrity.warnings`，与 `--trace` 可组合。
- 退出码：`0` 表示读到的 JSONL 全部通过校验；`2` 表示只能确认损坏/截断前的部分证据；`1` 表示参数或文件读取失败。
- `0` 不表示任务成功：没有 `run/finish` 时最近 run 为 `unrecorded_end`，生产日志也没有独立产物验收。派发后缺 usage 计入未知请求数；provider 输入 token 已包含缓存命中，不重复相加，也不估算历史费用。旧日志反映当时的模型和代码，不代表当前配置。

<details>
<summary>本地打包与安装</summary>

项目**尚未发布到 npm**，`private: true` 保留以防误发。下面从当前仓库生成 tarball，在仓库外的临时目录安装；已在 Windows 的含空格路径验证 `mini-dsh.cmd`。依赖首次安装可能需要访问包注册表；`--help`、`--version`、`--show-config`、`demo` 与 `inspect` 不需要 API key，也不会请求模型。

```powershell
$packRoot = Join-Path $env:TEMP ("mini-dsh-local-" + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $packRoot 'consumer space'
$workspace = Join-Path $packRoot 'sample project'
New-Item -ItemType Directory -Path $packRoot, $installRoot, $workspace | Out-Null
pnpm pack --pack-destination $packRoot
$tarball = (Get-ChildItem (Join-Path $packRoot '*.tgz')).FullName
pnpm --dir $installRoot add --ignore-scripts $tarball
$miniDsh = Join-Path $installRoot 'node_modules\.bin\mini-dsh.cmd'
Set-Location $workspace
& $miniDsh --help
& $miniDsh --version
& $miniDsh --show-config
& $miniDsh demo fix
```

本地安装验收覆盖 Windows 含空格路径；CI 的 `package-install` job（ubuntu-latest、Node 22）也在仓库外路径完成同一套 `--help`/`--version`/`--show-config`/`demo`/`inspect` 检查。macOS 安装未验证。

</details>

接入真实模型需先在 `.env` 填写 `DEEPSEEK_API_KEY`，再运行 `pnpm start`；**后续 CLI 对话可能产生模型费用**。不要覆盖已有 `.env`：

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# 在 .env 中填写 DEEPSEEK_API_KEY
pnpm start
```

默认工作区是启动命令时的当前目录（可用 `MINI_DSH_WORKSPACE` 覆盖），`.env` 也只从当前目录读取，已有环境变量优先；安装包内不带 `.env`。会话默认存于用户主目录的 `.mini-dsh/sessions`（可用 `MINI_DSH_SESSION_DIR` 覆盖），超长工具结果存于工作区的 `.mini-dsh/tool-results`。

## 设计取舍

三个容易做错、也最容易在面试里被追问的边界，连同代码与测试锚点写在 [CASES](docs/CASES.md)；五条核心选择的替代方案、失效模式和回归锚点见 [DECISIONS](docs/context-budget/DECISIONS.md)。

- **provider 重试不是工具副作用重试。** 只有 429、可重试 5xx 和连接建立失败会重试；已经产生内容或工具调用的部分流不静默重发，每次尝试单独经过派发闸门并计入预算。
- **截断输出必须保留真实尾部。** 每路 8 KiB 头 + 8 KiB 尾，持续排空两条管道；溢出中间段显式标记，`read_tool_result` 对缺口返回 `unavailable`。
- **更低的缓存账单不等于更高效。** 费用总是和 usage 覆盖、成功状态、请求数、工具调用数与主动时间一起报告；缺失字段记为未知，不当作 0。

## 生产配置与 v2.1 对照

生产入口 [src/index.ts](src/index.ts) 调用共用的 [createHarness](src/app/create-harness.ts)；评测入口也调用它；没有另复制一套 Harness。日常默认：

| 项 | 默认值 |
| --- | --- |
| profile | `coding` |
| 运行时钟 | `frozen` |
| 项目规则 | `live` |
| 工具结果预览 | 16 KiB |
| 输入目标 | 65,536 token |
| 主动压缩比例 | 0.8 |
| 溢出兜底 | 1 次 |
| 每段累计 token 上限 | 2M |
| `read_history` | 启用 |

- `MINI_DSH_CONTEXT_LAYOUT=live|frozen` 是旧版兼容入口；显式设置时同时控制运行时钟和项目上下文在系统提示里的文本是否固定。未设置时，项目上下文 `live`、运行时钟 `frozen`。它**不是**完整 Full 配置。
- `MINI_DSH_RUNTIME_TIME_MODE=live|frozen` 只控制运行时钟，优先于旧版布局对时钟的设置；默认 `frozen`。新会话有效值及来源可用 `--show-config` 核对。
- `MINI_DSH_TOOL_PREVIEW_BYTES` 控制有界工具结果进入模型历史的预览大小，默认 16,384 字节；超长结果可用 `read_tool_result` 回读。必须是正安全整数。
- `MINI_DSH_BUDGET` 沿用 CLI 的 JSON 预算配置，可调整输入目标、主动压缩、调用/工具/token/时间上限；`/budget` 查看当前会话的有效预算。溢出兜底与主动压缩是两条路径，关闭或推迟主动压缩不会自动关闭兜底。
- `MINI_DSH_PROFILE`、`MINI_DSH_WORKSPACE`、`MINI_DSH_PROJECT_DIRECTORY` 沿用既有配置；项目目录只决定初始规则上下文，不更改文件/Bash 工作区。

项目规则以 SHA-256 版本跟踪。同会话规则变化时提示 `Context version changed`，事件只记录摘要和前一版本摘要，不把规则正文或变化伪装成用户请求。实时规则布局显示当前版本；显式冻结布局仍用保存的规则快照，并提示用 `/reset` 或新会话刷新。

**frozen 会话与恢复：** `Time:` 和初始项目规则在该会话首次组装系统提示时取样，写入会话 JSONL；同一会话的后续轮次以及重启后用 `MINI_DSH_SESSION_ID` 恢复时复用原快照。同进程创建新的 sessionId 会重新取样；CLI 的 `/reset` 会清除可见历史，并在下次组装时重新取样。旧会话若没有保存快照、但已有模型请求，恢复时会明确提示：原始时间与规则无法还原，缺失部分按**当前**环境取样并标记为 `legacy-current`，不代表恢复了原快照。会话日志因此可能包含规则正文，应按工作区数据保护。

会话内 `AGENTS.md` 或项目配置变化不会自动修改 frozen 系统提示；`project_context` 工具读的是**当前磁盘内容**，可能与**本会话提示快照**不同。要让新规则进入系统提示，使用 `/reset`（丢弃可见历史）或启动新会话；仅恢复同一会话不会刷新。默认 live 在下一次组装时读取当前内容。没有全局热更新。新版本 frozen 日志增加两条快照事件，后续事件序号会变化；旧实验记录与严格回放规则未改，跨版本逐事件比较可能分歧。

v2.1 的 Full/Baseline 是冻结开发协议里的两条实验臂，不是生产默认；完整配置、冻结代码与变更边界见 [NX-45 开发协议](docs/context-budget/NX-45-DEVELOPMENT.md)。

## 实现入口

- [src/core/agent-loop-runtime.ts](src/core/agent-loop-runtime.ts)：请求投影、主动压缩和预算停止；[src/core/compaction-runtime.ts](src/core/compaction-runtime.ts)：摘要调用与结算。
- [src/core/session-runtime.ts](src/core/session-runtime.ts) 与 [src/core/event-store.ts](src/core/event-store.ts)：JSONL 事件、恢复和统计重建。
- [src/tools/files.ts](src/tools/files.ts)、[src/tools/bash.ts](src/tools/bash.ts)：有界读写、命令和验证证据；[src/plugins/tool-results.ts](src/plugins/tool-results.ts)、[src/plugins/read-history.ts](src/plugins/read-history.ts)：结果与历史回读。
- [src/models/deepseek.ts](src/models/deepseek.ts)：流式模型适配和 provider usage。配置入口在 [src/app/production-config.ts](src/app/production-config.ts)，无密钥查看在 [src/app/config-inspection.ts](src/app/config-inspection.ts)。

## 记忆与只读协作

项目记忆默认关闭，设 `MINI_DSH_MEMORY=assist` 可启用候选提案与按需检索，`recall` 只给模型检索工具。存储默认在 `~/.mini-dsh/memory/<projectId>/`；projectId 按真实工作区路径隔离，跨 worktree 需显式设置 `MINI_DSH_MEMORY_PROJECT_ID`。用 `/memory review [offset]` 检视来源、有效性、revision 和 digest，再用 `/memory approve <id> <revision> <digest>` 批准；模型没有批准工具。`/memory forget <id> <revision>` 撤销未来召回资格，已进入上下文和 JSONL 的内容仍保留。文件变化、来源不可达、过期和撤销都会拒绝回读。`pnpm demo:memory` 为零模型机制演示；实现状态见 [专题任务](docs/memory-team/TASKS.md)。

只读协作默认关闭，设 `MINI_DSH_DELEGATION=read-only` 后，主 Agent 可通过 `delegate_tasks` 调度 analyst/test_designer/reviewer。第一版同时最多两个子 Agent、每任务累计最多四个，子角色禁止写入、Bash、MCP 和递归委派。主/子/摘要/重试共用持久化根预算，`/continue` 不刷新额度和 wall deadline；`/budget` 显示根组统计，`mini-dsh inspect <root-events.jsonl> --tree` 展示子会话状态。审查结果绑定候选版本，后续编辑使其失效，可用 `review_status` 复核。`MINI_DSH_TEAM_LIMITS` 和 `MINI_DSH_TASK_GROUP_BUDGET` 接受有界配置，`--show-config` 显示实际值。`pnpm demo:team` 是脚本化机制演示，usage 为合成账本数据，不是供应商消费；真实效果尚未评测。

## 验证与边界

- **回归与 CI。** `pnpm check` 做 strict 类型检查、构建和产物语法检查；`pnpm test` 跑核心与 Cordis 集成测试，不需要模型密钥，集成测试实际执行 Bash。CI 覆盖 Ubuntu / Windows × Node.js 22 / 24，并包含 Linux 隔离测试与仓库外 tarball 安装检查。
- **离线机制证据。** `docs/samples/` 的两条合成轨迹可离线复算，`pnpm bench:components` 可复跑组件级信息保留与资源探针；它们验证机制与资源边界，不是模型能力分数。说明见 [EVALUATION](docs/EVALUATION.md) 和 [组件优化](docs/COMPONENT-OPTIMIZATION.md)。
- **不展示模型评测结果。** 本仓库不以模型评测结果作为项目展示内容：SWE-bench 四臂正式批次和结果仅保留在 [独立实验分支](https://github.com/BeforeLanding/mini-DSH/tree/feat/swebench-formal-results)，不合并 main；历史开发集探索不构成成功率提升、统计显著性或泛化结论。主分支保留的旧版协议与实现边界见 [EVALUATION-SWEBENCH](docs/EVALUATION-SWEBENCH.md)。

已知限制：

- 路径与命令闸门是应用层策略，不是操作系统隔离；Bash 仍能访问当前用户可读写的文件。
- MCP 默认不加载。stdio server 经内置启动器启动：只继承 PATH、locale、临时目录与 Windows 系统目录等运行变量，HOME/USERPROFILE 指向独立临时目录，显式配置的 `${ENV_NAME}` 引用按名字转交。provider key、代理、SSH agent 与 `NODE_OPTIONS` 默认不继承（这些名字也不允许显式转发）。这不是文件系统隔离：MCP server 仍能读取当前用户可读的文件。显式配置 server 即表示信任该进程。
- 工具调用在会话内串行执行，只读并发尚未实现。
- token 校准默认关闭；开启需要真实 provider usage 证据，固定语料的历史误差不代表完整请求分布。
- 未发布 npm、未创建发布 tag/Release；ECS 部署只保留手动入口，历史部署记录见 Actions，是否在服以服务器 `REVISION` 为准。安装验证覆盖 Windows 含空格路径与 Ubuntu CI，macOS 未验证。

## 文档索引

- [ARCHITECTURE](docs/ARCHITECTURE.md)：事件溯源、投影、压缩、工具、MCP 与隔离。
- [DECISIONS](docs/context-budget/DECISIONS.md)：五条核心选择的替代方案、代码锚点与测试锚点。
- [CASES](docs/CASES.md)：重试边界、命令尾部与成本口径三个工程案例。
- [RECRUITER_WALKTHROUGH](docs/RECRUITER_WALKTHROUGH.md)：面向招聘者的五分钟讲解顺序。
- [EVALUATION](docs/EVALUATION.md)、[EVALUATION-SWEBENCH](docs/EVALUATION-SWEBENCH.md)：证据分级与外部评测协议。
- [PROGRESS](PROGRESS.md)：已完成、验证、阻塞和下一步。
- [docs/README](docs/README.md)：完整文档索引。

## 来源与许可

仓库的教程基线来自[从零手写 mini-dsh](https://github.com/huangjunsen0406/mini-dsh/blob/main/LEARNING.zh-CN.md)，止于 `c5fc9c4`；`43e3829` 起是本项目的独立扩展。许可证与来源边界见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
