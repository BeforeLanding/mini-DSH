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
