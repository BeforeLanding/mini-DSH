# SWE full harness（2026-10-31，独立实验分支）

分支 `improve/swe-harness-advantage-20261031`，基于 `feat/swebench-formal-results`，不合并 main。目标：让组件在 SWE-bench 上真正触发，并在同模型、同环境、同 token 上限下比较 full 与基线。**本文件写的是诊断、改动与离线机制读数；真实成功率尚未测，不作提升结论。**

## 诊断：正式批次里候选输在哪里

只读 2026-10-24 正式四臂批次的**聚合**统计（`formal-evidence-final.tar.gz` 解压到仓库外），不按单题调参。

| 现象 | 读数 | 含义 |
|---|---|---|
| 命令环境 | 49/50 条候选轨迹出现缺包（numpy、pytest、erfa、django…）；基线 25/29 条可读轨迹同样出现 | 非 root uid + 临时 HOME 下 `bash -lc` 读不到 conda 激活，命令落在 base Python。两臂都几乎不能复现与跑测试 |
| 上下文组件 | 三个 mini-DSH 臂 150 条轨迹压缩事件 0；估算输入峰值约 33k，低于 65,536 触发线 | 旧任务裁剪以 task 为粒度，SWE 只有一个 task；context-reference 与 context-proposed 实际行为相同 |
| 预算 | 候选 37/50 条停在累计 416,666 token；平均 21 次请求，每次约 17k 输入 | 预算花在每轮重发越来越长的历史上 |
| 命令结果形态 | bash 结果以缩进 JSON 送入模型 | 转义的换行/引号与 cwd、signal、字节数等元数据每轮重付 |
| 补丁导出 | 22/50 条候选补丁含 `.mini-dsh/tool-results/*.json` | `exportPatch` 的 `git add -A` 把宿主结果存储带进了预测 |

## 改动

产品默认行为不变；以下均为显式开关，只由 `swe-full` 臂打开（环境与补丁导出两项对所有臂生效）。

1. **命令环境契约 `testbed-v1`**（两臂共用）：候选 `docker exec` 与外部 mini-SWE-agent 的解释器都换成显式激活 testbed 的同一包装；激活失败则命令不执行。批次开始前对每个唯一镜像跑零模型探针。`scripts/swebench/command-environment.ts`。
2. **补丁排除宿主产物**：`exportPatch` 排除 `.mini-dsh/`，并写入工作区 `.git/info/exclude`，Agent 的 `git status` 也看不到。
3. **任务内观测遮蔽 `observationWindow`**（投影组件）：当前 task 只保留最近 N 条工具结果正文，更早的换成头部 + `read_history from=<seq>` 的短桩；按 ceil(N/2) 成块推进以免逐轮破坏前缀缓存。只改请求投影，原始事件不动，`context/projection.maskedObservations` 记录触发。`src/core/observation-mask.ts`。
4. **紧凑命令结果 `toolOutputCommandFormat: 'text'`**（预览组件）：`exit 0 (0.2s)` + 分流正文；截断时保留头尾与 `read_tool_result ref/offset`。结构化值不变。swe-full 预览额度 8 KiB。
5. **预算提示 `budgetNotices`**（运行预算组件）：累计 token 越过 50%/75%/90% 时各写一条 `[harness budget]` user/message，跨多档只发最高档。
6. **收尾检查 `completionChecks`**（验证时效组件）：模型想结束时，工作区无改动、留有像临时脚本的新文件、或最后一次编辑后没跑过命令，各提醒一次（`[harness check:*]`）。
7. **任务工作流说明**：swe-full 臂追加一段系统提示（定位 → /tmp 复现 → 改源码 → 复跑 → 结束；输出要短）。Prompt 模板不变。

新协议 `preregister --protocol swe-full-v1 --command-environment testbed-v1` 生成三臂：`full`（swe-full）、`baseline`（未修改的 mini-SWE-agent 2.4.6）、`minimal`（2026-10 候选装配 + 同一环境）。三臂共用模型、镜像、416,666 名义 token 上限与请求/工具/时间上限。

## 离线机制读数（不是成功率）

把正式批 50 条候选轨迹的 1,053 次已记录请求按新投影重算估算输入（`D:\Agent\tmp\swe-analysis-scripts\replay.mjs`，仓库外）。估算器总量 17.90M，对照 provider 记录 17.25M，误差约 4%。

| 投影 | 估算输入 | 相对 v1 |
|---|---:|---:|
| v1 | 17.90M | — |
| 紧凑命令结果 | 16.19M | −9.6% |
| 紧凑 + 遮蔽（窗口 6，采用） | 11.91M | −33.5% |
| 紧凑 + 遮蔽（窗口 4） | 11.00M | −38.6% |

即同一上限下约可多走一半的请求。遮蔽后剩余上下文以推理内容为主（约 308k vs 工具结果 268k，50 条最终上下文合计）；DeepSeek 思考模式在工具循环内需要回传推理内容，因此不遮蔽它。这是反事实重放：模型拿到更短上下文后的行为会变，不能据此推断解题率。

## 待验证

- 先跑开发 5 题 × 3 臂冒烟：确认 testbed 探针通过、0 基础设施失败、`maskedObservations`/预算提示/收尾检查实际触发。
- 再跑留出题：从未曝光的题（排除原开发 5 题与原正式 50 题）× 3 臂，报告 full 对 baseline 与 full 对 minimal 的配对四格、McNemar、Wilson 区间、预算停止数、空补丁数与超限敏感性读数。原正式 50 题已被本次诊断读过聚合统计，复用只能当回归。
- 每批真实模型请求单独授权；本地 Docker Desktop 目前因 `%LOCALAPPDATA%\Docker\run` 下陈旧 socket 文件无法启动，需先恢复。
