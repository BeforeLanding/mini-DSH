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
