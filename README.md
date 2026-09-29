# mini-DSH

[![CI](https://github.com/BeforeLanding/mini-DSH/actions/workflows/ci.yml/badge.svg)](https://github.com/BeforeLanding/mini-DSH/actions/workflows/ci.yml)

仿 DeepSeek Harness 的 **mini coding agent harness**，使用 TypeScript / Cordis 构建本地编程 Agent 运行环境。按照 [从零手写 mini-dsh 学习指南](https://github.com/huangjunsen0406/mini-dsh/blob/main/LEARNING.zh-CN.md) 完成第 0～7 天主线及补充篇，每个阶段分别提交，随后扩展上下文、预算与持久化恢复。

开发主线是让模型在代码仓库中完成“理解项目规则 → 定位代码 → 修改文件 → 运行检查 → 根据失败修复 → 交付 diff 与验证证据”。当前已具备文件/Bash 工具及运行时底座；仓库规则加载、任务变更清单、结构化验证记录等仍是后续规划。首版聚焦单 Agent、单本地工作区与 CLI。

## 运行

需要 Node.js >= 20.18.1 和 pnpm 11.22.0。Windows 的 Bash 工具优先使用 Git for Windows 自带的 Bash；其他平台使用 PATH 中的 `bash`。

```powershell
pnpm install --frozen-lockfile
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
pnpm start
```

启动前在 `.env` 中填写 `DEEPSEEK_API_KEY`。`.env.example` 默认选择 `deepseek/deepseek-v4-flash`；未设置 `MINI_DSH_MODEL` 时选择 `deepseek/deepseek-v4-pro`。`MINI_DSH_WORKSPACE` 指定工作目录，默认是启动目录。Context7 为可选 MCP 服务，连接失败仍可进入 CLI。

CLI 支持 `/tools`、`/models`、`/model provider/model`、`/history`、`/prompt`、`/reset`、`/continue`、`/budget` 和 `/exit`。`/reset` 追加事件、清理可见历史并保留 session id 与原始 JSONL。运行或审批时按 Esc 取消，方向键不会触发取消。

写文件、编辑文件和执行 Bash 前会询问 `Allow this? [Y/n]`，空回车或 `y` / `yes` 同意。审批等待暂停主动时间，并有独立超时。`MINI_DSH_AUTO_APPROVE=1` 可用于受信任的测试环境。

## 结构

入口负责装配插件；`core/` 实现事件日志、工具注册表、提示词、模型路由和 Agent Loop；`plugins/` 将 runtime 暴露为 Cordis 服务；`models/` 实现 DeepSeek 流式协议；`tools/` 注册 Bash 和五个文件工具。

请求经过 CLI → agent.send → Agent Loop → Session Event Log → LLM；模型请求工具时经过 ToolRuntime，记录结果后继续下一轮。Loop 通过服务契约工作，不依赖具体模型或工具，底层未注入预算时没有固定次数上限；CLI 默认使用有限预算。

路径闸门检查词法路径、真实路径及尚未创建文件的父目录，拒绝软链越界。命令策略用于防止误操作，审批负责确认执行；这是应用层策略，不是操作系统隔离。

## 验证

```powershell
pnpm check
pnpm test
```

当前 72 条测试，保留原 22 条核心/Cordis 回归，并增加预算、容量、持久化、恢复、续跑和 CLI 测试。集成测试使用模拟模型，但实际执行 Bash，并验证文件工具、工具卸载和可选/必需插件的失败行为。测试不需要 API Key。

NX-05a 提供三个可重复的 [编程任务 fixture](test/fixtures/coding/README.md)：边界修复、功能扩展和跨文件接口修改。运行 `pnpm fixtures:check` 核验初始失败/参考通过基线；`pnpm test` 还覆盖模拟模型经真实文件/Bash 工具完成失败→修改→重跑的流程。每次使用新临时工作区，独立验收器保留在工作区外；模拟结果不代表真实模型编程成功率。

GitHub Actions 在推送到 `main`、提交 Pull Request 或手动触发时运行 CI，覆盖 Ubuntu / Windows 和 Node.js 22 / 24。工作流按 `package.json` 固定的 pnpm 版本安装依赖，使用 `--frozen-lockfile`，然后运行 `pnpm check` 和 `pnpm test`，无需 DeepSeek 或 Context7 密钥。

`pnpm lint` 暂未作为 CI 门槛：当前代码尚未通过 Biome 的格式与规则检查，统一规范后可再加入。

若编码 Agent 的受限沙箱内出现 pnpm 版本引导失败或 Cordis `ERR_MODULE_NOT_FOUND`，先在正常用户终端核验 `pnpm --version` 与上述安装/检查命令。依赖目录可能存在但沙箱无法访问；确认实际安装问题后再修复，保持固定 pnpm 版本和锁文件校验。当前本地恢复结果见 [PROGRESS.md](PROGRESS.md)。

## 开发协作

围绕 mini coding agent harness 的 [完成度评估与开发路线](docs/INTERNSHIP_ROADMAP.md) 包含三个已复现边界、仓库上下文、可靠编辑、执行验证、编程评测和求职展示；规划项尚未实现。

本轮 TypeScript、持久化、上下文、预算及续跑功能的完整梳理见 [改动与实现功能](docs/context-budget/CHANGES.md)。

开发前阅读 [AGENTS.md](AGENTS.md) 与 [PROGRESS.md](PROGRESS.md)。上下文与执行预算管理的开发基线由[需求与验收](docs/context-budget/REQUIREMENTS.md)、[计划、设计与参数](docs/context-budget/PLAN.md)和[任务清单](docs/context-budget/TASKS.md)组成；TypeScript、持久化、上下文/执行预算及继续功能已实现，验收证据见任务清单与进度。

## TypeScript 开发

源码、配置与测试使用 TypeScript（strict / NodeNext）；相对导入使用 `.js`。`pnpm typecheck` 检查类型，`pnpm build` 先校验后清理并编译到 dist，`pnpm check` 检查类型、构建和产物语法，`pnpm test` 构建后运行编译测试，`pnpm start` 构建后启动。plugins.config.ts 编译到 dist 根目录；cwd 与 .env 语义不变。scripts 的 Node 引导程序保留 JavaScript，不依赖类型剥离。

## 预算、持久化与续跑

终态提交确认也计入主动预算，另有 `finalizationTimeoutMs`（默认 5000ms）控制收尾上界。超时或取消不会返回成功；若终态已开始写入而无法及时确认，`/budget` 显示 `terminalCommit.status=uncertain`，必须关闭并恢复 session 核验日志后才能继续。迟到写入不会更改当前进程的停止状态；恢复遵循实际完整落盘的唯一终态。终态事件计时是提交前快照，当前进程的主动时间观测包含提交等待。

CLI 默认每段模型请求64次、工具128次、主动10分钟、累计2M token，输入目标64Ki、最大输出16Ki、最低输出预留4Ki。容量余量为 max(2048,input估算10%)。模型请求180秒，审批300秒；Bash保留30秒。用 `.env` 中 `MINI_DSH_BUDGET` JSON 或 `/budget {"maxModelRequests":8}` 覆盖，`/budget` 查看有效配置、最近run、任务累计、估算来源和裁剪任务ID。次数/总额0表示零额度；输出和容量必须为正整数。

默认写入 `~/.mini-dsh/sessions/<sessionId>/events.jsonl`，CLI打印session ID；可用 `MINI_DSH_SESSION_DIR` 改目录，设置 `MINI_DSH_SESSION_ID` 在同一规范化工作区恢复。单写入者持锁；正常退出等待写入并释放锁。失效writer.lock需人工确认旧进程与副作用后处理；不会仅凭PID自动解除。尾部半条事件拒绝恢复；可在核验后调用 `JsonlStore.quarantineTail(directory,id)` 保存原日志并隔离尾部，中部损坏或未知版本明确报错。

停止后 `/continue` 关联同一task的新run，沿用有效额度并累计任务用量，不复制用户输入、不重放已完成或未知工具。completed不继续；context_overflow需先调整上下文配置；unknown需先人工核验副作用，再开始明确的新任务，自动续跑会拒绝。`/model` 和 `/budget` 设置追加到日志，恢复保留，reset清理任务并保留当前配置。

上下文只在请求投影中移除最旧完整任务；system、安全规则和当前task所有run保留，装不下时context_overflow。Token估算用ASCII0.3/其他Unicode1.0，加消息32/请求256开销；provider usage优先，缺失/中断记estimated和uncertain，不当作零或精确账单。估算误差可能让实际消耗超额度，后续调度仍会停止。自定义模型/端点须显式提供contextWindowTokens；官方DeepSeek能力由适配器元数据提供，不根据任意模型名猜容量。

不遵守AbortSignal的第三方工具可能在停止等待后继续执行，其结果标unknown。恢复是事件重建，不能恢复文件系统快照。测试使用模拟模型，不调用付费API。
