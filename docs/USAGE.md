# 使用指南

[返回项目介绍](../README.md) · [文档索引](README.md)

本文补充日常 CLI 命令、预算与恢复、配置来源、日志检查和本地安装。首次使用见 [快速开始](../README.md#快速开始)。下文仓库命令均从仓库根目录执行，命令行示例使用 PowerShell。

## CLI 命令

直接输入自然语言开始任务；以斜杠开头的命令用于管理会话：

- 查看能力：`/tools` 列出工具，`/models` 列出模型，`/model provider/model` 切换模型。
- 查看结果：`/changes [fileOffset]` 查看文件工具变更；`/diff [fileOffset] [byteOffset]` 查看 diff；`/report [fileOffset] [verificationOffset] [byteOffset]` 查看检查证据。按输出中的续读提示翻页。
- 查看过程：`/trace [requestOffset] [byteOffset]` 查看请求摘要，`/history` 查看原始事件，`/prompt` 查看系统提示。
- 管理预算：`/budget` 查看当前额度与用量，`/budget {"maxModelRequests":8}` 修改配置；`/continue` 尝试继续已停止任务。
- 管理上下文：`/compact` 请求压缩当前任务历史，可能调用真实模型；`/reset` 清除可见历史，保留 session ID 和原始 JSONL，并在下次组装时刷新冻结快照。
- 运行或审批期间按 Esc 取消；`/exit` 退出。

默认写文件、编辑文件和执行 Bash 都会询问 `Allow this? [Y/n]`，空回车或 `y` / `yes` 同意。审批等待不计入主动执行时间，另有审批超时。`MINI_DSH_AUTO_APPROVE=1` 可为受信任环境启用自动批准。

`/changes` 和 `/diff` 只覆盖文件工具记录的修改，Bash 或外部程序修改须结合 Git 检查。`/report` 区分检查通过、失败、过期和未知；它的 `acceptance` 始终为 `not_asserted`，命令退出 0 与任务结束均不自动证明任务验收。

## 预算与继续任务

默认每段运行最多 64 次模型请求、128 次工具调用、10 分钟主动执行时间和累计 2M token，输入目标 65,536 token。用 `MINI_DSH_BUDGET` JSON 或 CLI `/budget` 调整；当前有效配置和停止原因以 `/budget` 为准。token 估算不构成供应商计费硬上限。

预算停止后可用 `/continue` 开始同一任务的新一段运行，保留已有事件与任务累计用量。已完成工具不会重新执行；已完成任务不能继续，`context_overflow` 需先调整上下文配置。工具结果为 `unknown` 时须人工核验副作用，自动续跑会拒绝。

## 保存与恢复会话

默认会话日志位于用户主目录 `.mini-dsh/sessions/<session-id>/events.jsonl`，工具结果位于工作区 `.mini-dsh/tool-results`。启动时会打印 session ID；可分别用 `MINI_DSH_SESSION_DIR` 与 `MINI_DSH_WORKSPACE` 指定存储位置和工作区。

退出后可在相同工作区恢复已有会话。PowerShell：

```powershell
$env:MINI_DSH_SESSION_ID = '<启动时打印的 session-id>'
node dist/src/index.js
# 结束后取消本终端的恢复设置，下次即可创建新会话
Remove-Item Env:MINI_DSH_SESSION_ID
```

bash 中变量只作用于这一条命令，结束后无需取消：

```bash
MINI_DSH_SESSION_ID='<启动时打印的 session-id>' node dist/src/index.js
```

恢复重建事件状态，不恢复文件系统快照，也不重跑未知工具。若崩溃留下写锁，先用 `pnpm session:lock <session-id>` 查看锁体、进程探针和日志尾部；只有人工确认旧进程与副作用后，才使用输出提示的 token 显式解除。不要直接删除日志或凭 PID 自动解锁。

## 工作区、密钥与 MCP

`.env` 只从启动时的当前目录读取，已有环境变量优先；安装包不带 `.env`。从仓库启动时，可在 `.env` 填写 `DEEPSEEK_API_KEY`，并用 `MINI_DSH_WORKSPACE` 指向其他项目的绝对路径。`MINI_DSH_PROJECT_DIRECTORY` 只选择初始规则上下文，不改变文件/Bash 工作目录。

当前内置 DeepSeek 模型适配器；模型名用 `MINI_DSH_MODEL` 配置，示例文件选择 `deepseek/deepseek-v4-flash`。`DEEPSEEK_THINKING` 原样作为请求的 `thinking.type` 发送，取 `enabled`（默认）或 `disabled`；关闭后模型不返回推理内容，CLI 也不显示 `[Thinking]` 段。模型列表以 `/models` 为准；更换 provider 需要接入适配器。

MCP 默认不加载 server。用户配置位于 `~/.mini-dsh/mcp.json`，可用 `--mcp-config <path>` 或 `MINI_DSH_MCP_CONFIG` 指定；不自动加载工作区中的 `mcp.json`。`MINI_DSH_MCP=0` 可禁用。stdio server 使用收紧的环境继承与独立临时 HOME，仍能访问当前用户可读的文件；显式配置表示信任该进程。


## 只读检查会话日志

已有 `events.jsonl` 可在无 API key、无模型请求时查看。`inspect` 不恢复会话、不获取写锁，也不执行日志里的命令或工具；路径可以位于含空格的目录。PowerShell：

```powershell
$log = Join-Path $env:USERPROFILE '.mini-dsh\sessions\<session-id>\events.jsonl'
node dist/src/index.js inspect $log
node dist/src/index.js inspect $log --json
node dist/src/index.js inspect $log --trace
```

bash：

```bash
log="$HOME/.mini-dsh/sessions/<session-id>/events.jsonl"
node dist/src/index.js inspect "$log"
node dist/src/index.js inspect "$log" --json
node dist/src/index.js inspect "$log" --trace
```

- 文本默认列出会话和最近一次 run 的状态、请求/重试/派发前拒绝、工具结果、provider token 与缓存、缺 usage、摘要及 `read_history` 次数、frozen 快照来源。
- `--trace` 只附带最近 40 条所选事件的序号、类型、工具名或终止原因；不显示提示正文和工具输出。
- `--json` 返回版本为 `2` 的结构化数据，含 `integrity.complete`、`integrity.warnings` 与最近运行错误的安全摘要 `errors`，与 `--trace` 可组合。
- 退出码：`0` 表示读到的 JSONL 全部通过校验；`2` 表示只能确认损坏/截断前的部分证据；`1` 表示参数或文件读取失败。
- `0` 不表示任务成功：没有 `run/finish` 时最近 run 为 `unrecorded_end`，生产日志也没有独立产物验收。派发后缺 usage 计入未知请求数；provider 输入 token 已包含缓存命中，不重复相加，也不估算历史费用。旧日志反映当时的模型和代码，不代表当前配置。

## 检查生效配置

```shell
node dist/src/index.js --show-config
```

该命令不需要 API key、不请求模型、不创建 CLI 会话；只读装配同一 Harness，输出新会话的模型、布局、工具预览、预算与配置来源，不打印密钥、环境变量全集或项目规则正文。非法配置直接报错。设置了 `MINI_DSH_SESSION_ID` 时会拒绝查询，避免把新会话配置当作恢复会话的配置；恢复后用 `/budget` 查看有效预算。

## 生产配置与 v2.1 对照

生产入口 [src/index.ts](../src/index.ts) 调用共用的 [createHarness](../src/app/create-harness.ts)；评测入口也调用它；没有另复制一套 Harness。日常默认：

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

v2.1 的 Full/Baseline 是冻结开发协议里的两条实验臂，不是生产默认；完整配置、冻结代码与变更边界见 [NX-45 开发协议](context-budget/NX-45-DEVELOPMENT.md)。

## 扩展分支

本指南对应 main 的单 Agent CLI。项目记忆、只读协作及专属配置/命令仅保留在 [feat/memory-team-eval-v2](https://github.com/BeforeLanding/mini-DSH/tree/feat/memory-team-eval-v2)，不在 main 启用。扩展分支的会话包含专属事件，切换分支时使用独立会话目录，不把扩展会话当作 main 日志恢复；原始日志保持不变。

## 本地打包与安装

项目**尚未发布到 npm**，`private: true` 保留以防误发。下面从当前仓库生成 tarball，在仓库外的临时目录安装；已在 Windows 的含空格路径验证 `mini-dsh.cmd`。依赖首次安装可能需要访问包注册表；`--help`、`--version`、`--show-config`、`demo` 与 `inspect` 不需要 API key，也不会请求模型。PowerShell：

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

bash（Linux/macOS，或 Windows 的 Git Bash）：

```bash
packRoot=$(mktemp -d)
installRoot="$packRoot/consumer space"
workspace="$packRoot/sample project"
mkdir -p "$installRoot" "$workspace"
pnpm pack --pack-destination "$packRoot"
tarball=$(find "$packRoot" -name '*.tgz' -print -quit)
pnpm --dir "$installRoot" add --ignore-scripts "$tarball"
miniDsh="$installRoot/node_modules/.bin/mini-dsh"
cd "$workspace"
"$miniDsh" --help
"$miniDsh" --version
"$miniDsh" --show-config
"$miniDsh" demo fix
```

本地安装验收覆盖 Windows 含空格路径；CI 的 `package-install` job（ubuntu-latest、Node 22）也在仓库外路径完成同一套 `--help`/`--version`/`--show-config`/`demo`/`inspect` 检查。macOS 安装未验证。
