# SWE 组件效果优化（2026-10-30）

工作在独立 SWE 实验分支上，不合并 main。目标是同模型、同任务、同执行环境和预算下观测各组件的触发与边际贡献，最后独立判分 full 相对 baseline 的成功率。没有观察到提升时保留负结果，不以改口径达成目标。

## 开发证据与故障

只检查已曝光五题的共享 token 开发批（`outputs/mini-dsh-swebench-formal-20261022/development-evidence`），不读旧正式题的 gold 或失败轨迹来调参。候选 5 题中 4 题 `token_budget`；15 条 mini-DSH 轨迹没有一次摘要事件。最后已发请求的估算输入约 13k–44k，低于原压力线 52,428；累计预算先耗尽，不能用该批推断摘要有无收益。

候选重复运行基础环境的 Python，出现缺 pytest、erfa、werkzeug 等错误；把 `/testbed`、`/opt` 用作宿主工具 cwd 又被路径策略拒绝。原容器用临时 HOME，不会读取 root 的 testbed 激活配置；`bash -lc` 并未保证进入 testbed。上述错误是环境适配故障，不能算作组件能力差异。

## SWE-O1：显式环境契约

- manifest `environment.commandEnvironment` 可选 `legacy` / `testbed-v1`；缺省保持历史行为，旧 manifest 恢复时不额外写入字段。
- 新协议候选和 mini-SWE-agent 都使用相同的显式 conda 激活脚本；命令独立 argv 传入，激活失败不执行命令，不回落到 base Python。所有新实验必须使用 `--command-environment testbed-v1` 重冻，不能把新旧环境混入同一次对照。
- Docker 后端在创建证据目录及发模型请求前，对本批每个唯一固定镜像运行零模型探针，确认 testbed prefix 与 pytest 可导入；失败直接停止。输出写入 `environment-preflight.json` 并进入 SHA256SUMS。
- 候选增加路径说明：文件工具、Bash cwd、verification.files 采用仓库相对路径；Bash 命令在容器 `/testbed` 运行。保留原路径闸门、隔离、宿主 env 不转发等边界。

验收：构建通过；SWE 定向 38/38；完整 594 tests / 564 pass / 0 fail / 30 平台 skipped；语法 235 文件、Biome 267 文件零诊断。真实 Bash 测试验证激活失败/缺脚本不执行动作、多行/引号保持原文、退出码原样返回。Docker Desktop 引擎本机暂未响应，真实镜像探针仍待运行；本步不能声称已完成镜像环境实测。模型请求 0。

## 验收边界

摘要索引和报告快照共享主要改善本地 CPU/I/O，输出等价时不预期直接提高 resolved@1；必须分别报告机制成本与模型结果。预览/回读、上下文压缩等可能改变模型可用证据的组件才适合以逐项消融诊断能力影响。

新组件开发批要有 full、同源基线与逐项去除臂；外部 mini-SWE-agent 另作产品比较，不能代替同源归因。所有触发均从原始事件复算，缺失事件记未知；零触发只能判未覆盖。旧 50 题已曝光，后续复用只作回归；任何泛化结论需新留出题、独立评分与全部计划任务分母。

真实模型执行仍须冻结具体配置、当前价格和每批金额授权；不得自动重跑已执行 episode 或改写历史证据。

## SWE-O2：组件实际触发与同源消融

新增 `--protocol swe-components-v1`：六臂为 full、harness-baseline、without-context、without-tool-output、without-project-context、外部 baseline。同源五臂共享源码、模型、固定系统布局与总预算；各去除臂只改变声明的组件，最小基线同时关闭三项。预览额度统一 16 KiB。新协议强制 testbed-v1、六臂顺序与完整配置，冻结 sourceCommit；执行前拒绝产品/脚本/配置的已跟踪或未跟踪源码漂移。旧协议的默认臂不变。

每条 mini-DSH episode 从已确认原始事件派生摘要尝试/应用、预览截断/回读、实际注入的非空项目规则、验证/报告查询与峰值估算输入。报告 CLI 用严格 JSONL 校验重新读取轨迹，不信任缓存指标。报告区分 observed / not-exercised / unknown；缺失轨迹不补零，不把触发当收益。五组配对均保留计划任务分母，缺评分的比较标 incomplete；重复/计划外记录与评分拒绝。另自动报告 token 超限与限额内成功数，保留主要官方评分。

旧开发批只读复算：15/15 轨迹完整，摘要应用 0，预览截断 13，成功回读 0，验证结果 11。明细只存仓库外 `D:\Agent\outputs\swe-component-effects-20261030\development-diagnostics.json`，无新增模型请求。

验收：SWE 定向 40/40；完整 596 tests / 566 pass / 0 fail / 30 平台 skipped（`D:\Agent\tmp\swe-component-o2-full-20261030.log`）。脚本化端到端实际经过 createHarness、AGENTS.md 注入、大结果存储/回读、真实 Bash 检查、task_report 和独立 mock 判分；同时验证去除臂差异和零摘要的未覆盖结论。这是机制测试，不是模型成功率提升。

## SWE-O3：在累计预算耗尽前压缩

仅调整新组件实验协议，不改生产 CLI 默认值或旧 manifest：五个同源臂统一冻结 compactionBudgetTokens=16,384、compactionMaxTokens=2,048；自动摘要开关是逐项去除的唯一上下文差异。硬输入目标仍 65,536，累计 token/请求/工具/时间上限不增加，摘要请求与 usage 全额计入同一预算；postCompactionPrune 仍显式关闭。

复现故障的零模型长任务包含 24 次大结果检查与最后一次修复。在相同 416,666 累计 token 限额下，原 65,536 压缩预算在第 16 次检查后停于 token_budget，摘要 0 次、未修复；新策略使用 5 次短摘要后完成全部检查与修复，总合成 usage 约 251k，未超预算。这里的 usage 由实际请求长度确定性生成，不能当作真实 provider usage、SWE 得分或因果收益。无效摘要反例验证两次失败后关闭自动尝试，仍按原 token_budget 停止，不会把失败摘要算为应用。全部原始工具事件保留，用户请求与工具调用/结果协议均验证完整。

验收：SWE 与全部 compaction 定向 91/91；完整 598 tests / 568 pass / 0 fail / 30 平台 skipped（`D:\Agent\tmp\swe-component-o3-full-20261030.log`）；构建通过。尚未跑新策略的真实模型开发批，不宣称成功率提升。

## SWE-O4a：开发批冻结与零模型预检

`--scope development` 只要求开发题的镜像 digest 齐备；manifest 的 executionScope 阻止误执行 formal。正式留出题可以先选择，但该分割未冻结，不授予执行权限。省略 scope 的历史文件仍按原 all 行为读取。新增 `--validate-only`，执行源码/镜像/基线安装/隐藏评分行/环境预检后在创建证据目录、调用 adapter 或评分器之前返回；CLI 与 `--execute` 必须二选一。

验收：SWE 定向 43/43，完整 599 tests / 569 pass / 0 fail / 30 平台 skipped（`D:\Agent\tmp\swe-component-o4-full-20261030.log`），构建通过。机制测试确认 validate-only 的 adapter/scorer 调用均为 0、证据目录不创建，开发专用 manifest 对 formal 的执行也在请求前拒绝。

## 最终冻结与当前阻塞（SWE-O4c）

被测源码提交 `3b03f48b39a25f0b78662e314c6b17d0857b4592`；后续只有证据文档提交。开发清单 SHA-256 为 `d7991e5f6a68f2eda273d71bf59e8ba68ca34b8f2e4e4687e3e07c1441c5ee6b`，完整准备材料在仓库外 `D:\Agent\outputs\swe-component-effects-20261030\`。

- `batch-plan.json`：可审阅的批次范围、开关、源码身份、预算与未执行状态。
- `manifest-development.json`：`swe-components-v1`、development-only、5 题 × 6 臂 = 30 个计划 episode，实际执行 0、provider 请求 0。五题仍为已曝光开发题，不能作泛化结论。
- 单题每臂配置 $0.50、名义累计 token 416,666、64 请求、128 工具、900 秒主动时间、单请求输出 16,384。30 条的配置储备 $15，另 $2 储备，总 batch cap $17。预检不发协议探测请求，不自动补跑。
- `prices-20261030.json`：2026-10-30 按 [DeepSeek 官方价格页](https://api-docs.deepseek.com/quick_start/pricing/) 核对 DeepSeek-V4.1-Flash-1017；每百万 token 峰值输入 $0.30、缓存输入 $0.006、输出 $1.20。只是 usage 估价所用的价格上界，不是账单承诺。
- 后续正式 50 题只完成不按结果挑题的选择，排除原开发 5 题与原正式 50 题；没有冻结其镜像、没有执行授权。`executionScope=development` 会机械拒绝 formal。

WSL 中的 Node 24.16.0 导入新执行器成功，外部 mini-SWE-agent 2.4.6 的 config/install SHA-256 均与冻结值相同。真实源码探针确认：干净源码通过、跟踪文件临时改动拒绝、未跟踪源文件拒绝，探针结束后原字节恢复且工作区干净。这里的源码身份采用 Git blob 的行尾规范化，仅对 WSL 读取 Windows worktree metadata 做局部 argv 适配，不设置全局 GIT_DIR。

最终 `validate-development.sh` 的 8 项不可变文件校验和全部通过；源码关卡通过后，在 Docker 连接预检失败并停止。`runtime-readiness.json` 记录 Ubuntu WSL 的 Docker 集成不可用；Docker Desktop 虽有进程但没有可操作窗口。未创建运行证据目录，未读取真实 key，未调用模型或官方评分器。真实镜像上的 testbed/pytest 探针尚未通过，不能宣称运行环境已验收。

恢复 Docker Linux 引擎和 Ubuntu WSL 集成后，先执行零模型 `validate-development.sh`。只有该预检成功且用户按 [原 SWE 付费授权要求](../EVALUATION-SWEBENCH.md) 授权本批 30 条及 $17 配置上限后，才执行 `run-development.sh`；脚本先核验 SHA256SUMS 并拒绝覆盖已有证据。中断证据保留，不自动重跑。基线 watchdog 的最后一步可能越过名义 token cap，仍须保留主评分、超限计数和限额内敏感性读数，不把名义限额当作精确消耗相等。

最终本地验收：构建通过，语法 238 文件、Biome 270 文件零诊断；完整 601 tests / 571 pass / 0 fail / 30 平台 skipped（`D:\Agent\tmp\swe-component-portable-final-20261030.log`）；fixtures、12/12 离线任务与 tools/compaction/reports 三项基准通过。没有新增真实 SWE 得分，不能宣称 full 成功率已经提升。按原分支边界保留独立实验，不合并 main。

## 用户授权与环境恢复复核

用户已在本次对话明确授权**仅本批 30 条开发 episode、配置总上限 $17**，并说明暂时无法恢复 Docker。授权摘要保存在仓库外 `authorization.json`，绑定上述 manifest SHA-256；没有修改冻结文件或校验和，也不覆盖正式题、自动复跑或新增资源。后续无需重复询问该批预算，但运行前仍须通过零模型预检。

草稿 [PR #13](https://github.com/BeforeLanding/mini-DSH/pull/13) 以独立 `feat/swebench-formal-results` 为 base，代码 HEAD `b572596` 的 [CI 41057455030](https://github.com/BeforeLanding/mini-DSH/actions/runs/41057455030) 六项实际 job 全绿；Official SWE-bench no-model PoC 按普通 PR 配置 skipped。没有合并 main。

恢复复核：Docker Desktop 的 start 命令返回 already running，但 status/engine/restart API 无响应；WSL 发行版列表显示 Docker 引擎停止，当前 backend 日志再次出现错误 1920/本地 socket 故障。2026-10-24 相同错误的历史记录说明 Windows 重启后曾恢复引擎，但本次尚未恢复。已停止本任务自己挂起的重启 CLI，未删除 Docker 数据。当前仍是实际 episode 0、模型请求 0、官方新评分 0；剩余前置条件仅为本地环境恢复及真实镜像预检通过。目标尚未达成，不能把机制测试写成 full 成功率提升。

## 远端真实镜像环境验收（SWE-O5）

本地 socket 故障仍在，现有公开仓库的 Actions Docker 可用。首次 run `41059541216` 失败证据保留：四镜像通过 testbed/pytest 后因探针父目录缺失退出，Django 被错误要求 pytest。`027236b` 修正合法原生 runner 的 pytest 可选观测，完整 602/572/0/30；`8b7427b` 修复探针目录。

[第二次 run 41060962921](https://github.com/BeforeLanding/mini-DSH/actions/runs/41060962921) 实际五镜像全部通过：固定 registry digest 与对应 image ID 一致，testbed Python prefix 正确，各项目依赖导入成功，真实候选容器保持无网络/只读根/单一工作区挂载，宿主文件工具目录与容器 Bash 双向可见。同容器内旧 `bash -lc` 的环境探针 0/5 通过，新显式激活 5/5 通过；Django pytest 观测为 null 且原生依赖正常，不安装任何镜像外依赖。机读结果见 [公开环境证据](../samples/swe-component-environment-result-20261030.json)。原始 job artifact 已下载保存在仓库外。

修复后源码 `027236b85573ac6cfdffae0fd09f9206ab975480` 的新开发 manifest SHA-256 为 `b713df5768dc816ae39a893e9aba3e73010ec102e8ab34b9426e6f54525f3e82`。旧清单/授权/校验和保存在 `frozen-source-3b03f48/`；机器比较确认只有 sourceCommit 与 createdAt 改变，五题/六臂/模型/价格/预算完全一致。用户的同批 30 条/$17 范围未扩大，实际模型请求仍为 0。

既有 baseline venv 的 uv pip check 确认 123 个包兼容，config/install 指纹先前已匹配。现有 GitHub 仓库没有模型 secret；远端付费运行尚未具备凭证通道。下一步准备无 key 的全链路预检及加密原始证据交付，再就临时 secret 的具体目的地取得明确同意，不上传本机 key。
