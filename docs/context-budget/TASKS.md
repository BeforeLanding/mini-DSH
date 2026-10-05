# 任务清单

更新：2026-10-05。每项只保留当前状态和证据入口；行为、边界、逐步提交与完整验收记录见 [CHANGES](CHANGES.md)。状态：`todo`、`in_progress`、`blocked`、`done`。

### NX-34 上下文压缩

| 子步骤 | 行为与状态 | 独立验收 | 预计提交 |
|---|---|---|---:|
| NX-34-0 | R-22／D-21 立项与契约修订（**done**） | 不改 `src/`；原始用户请求在可压缩段之前保留；`git diff --check` 退出 0 | 1 次 |
| NX-34-1 | 事件词汇、纯 `planCompaction` 与事件校验（**done**） | 规划器确定性、边界与非法载荷测试；`node scripts/check-syntax.js` 退出 0；不调用模型 | 1 次 |
| NX-34-2 | 投影遮蔽、frame、保护集与协议完整性（todo） | 重复投影逐条相等；保留原请求及工具配对 | 1 次 |
| NX-34-3 | 脚本化假摘要闭环（todo） | applied 投影、恢复与预算端到端，零付费 | 1 次 |
| NX-34-4 | 真实摘要调用、三入口、预算与失败闩（todo） | 模拟模型验证计数、取消、失败及溢出上界 | 1 次 |
| NX-34-5 | `read_history`（todo） | 原文逐字回读、分页、隔离与上限 | 1 次 |
| NX-34-6 | 恢复时闭合未完尝试（todo） | `unclosed` 落盘且恢复不调模型 | 1 次 |
| NX-34-7 | 三类 fixture、CLI `/compact`、演示与文档（todo） | 六条验收命令及 `pnpm demo:compact` 实跑；活锚点与计数复核 | 1 次 |

### NX-33 大工具结果的尾部窗口

| 子步骤 | 行为与状态 | 验收 | 预计提交 |
|---|---|---|---:|
| NX-33-0 | 立项、D-20 与 R-15 契约（**done**，`0db8f8d`） | PLAN 两条截断路径、尾部预算和中段省略规则已写明；R-15 保留现有回读与事件契约；`git diff --check` 退出 0 | 1 次 |
| NX-33-1 | 通用结果与 Bash 流的尾部窗口、工具描述及测试（**done**，`60d76a4`） | 新增三条测试；既有 eval 断言逐字保留并增加尾部哨兵断言；`pnpm check` 为 `syntax ok: 93 files`，`pnpm test` 为 220/220 | 1 次 |
| NX-33-2 | README／PLAN／CHANGES／PROGRESS／TASKS 回填与全量验收（**done**） | 活锚点实测并订正；`pnpm check` 93 文件、`pnpm test` 220/220、`pnpm lint` 102 文件 0 诊断、16 项 fixture、离线评测 12/12、估算器与语料钉版均通过；CHANGES 只追加 NX-33 节 | 1 次 |

## 待办

**NX-08 与 NX-09 两支均已收尾**：NX-08 的对照 A 完成（NX-08e）、对照 B 以「仪器未成立」的负面结果归档（NX-08f），结论合并进 [NX-08-REPORT](NX-08-REPORT.md)；NX-09 的 M9 交付件七步全部落地（子步骤见下方 [NX-09 一节](#nx-09-readme-定位原创增量架构图与零密钥运行入口)）。**NX-10（M9 演示）已完成**（2026-10-01，零付费，子步骤见下方 [NX-10 一节](#nx-10-固定代码修复演示三幕零付费)）——它是 NX-09 收尾后按用户指示从「其他待办」里选定的。**NX-11（整理设计取舍）已完成**（2026-10-01，零付费，子步骤见下方 [NX-11 一节](#nx-11-整理设计取舍五节零付费)）——M9 三块（NX-09／NX-10／NX-11）到此全部收尾。**NX-08h（打破任务集天花板，方案 2）进行中**（2026-10-01，子步骤见下方 [NX-08h 一节](#nx-08h-打破任务集天花板方案-2无公开检查变体)）——它是「其他待办」里由用户选定的下一项，离线部分零付费，付费烟测单独授权；其余待办仍未排期。下面 NX-08 各节保留为执行记录；整批上限、各臂一致的单次 run 预算与预注册口径见 [PLAN 的评测批次上限](PLAN.md#nx-08-评测批次上限预注册)，预注册参数在开跑后不得再单独调整某一臂或某次重复。

NX-08e 开跑前必须先解决其前置条件（2026-09-30 修正）：裁剪要求会话中存在**已结束且可裁剪的旧任务**，单任务会话无论多大都不会触发——当前 task 与 `/continue` 的续跑段恒受保护（依据见 [PLAN 的对照有效性条件](PLAN.md#nx-08-评测批次上限预注册)）。现有驱动每个 fixture 只发一次 `send`，因此筛查跑的 `removedTaskIds` 全为空属结构性必然。

前置设施 NX-08e0 三步均已完成：e0-1 修正条件与需求、e0-2 让驱动支持同一会话内的任务序列（契约见 [PLAN](PLAN.md#nx-08e0-阶段序列驱动契约)）、e0-3 离线量化越过输入目标所需的旧任务规模（实测同量级阶段约需 3～4 个）。

多阶段依赖 fixture 已落地并扩到**十四阶段**（`pipeline`，实现在 `test/fixtures/coding/pipeline/`，契约与阶段数依据见 [PLAN](PLAN.md#nx-08e1-多阶段依赖-fixturepipeline)）。e2 各步已完成：逐阶段投影观测（e2-1）、入口按阶段参数化与 `--plan-only`（e2-2）、真实模型烟测（e2-3）、验收放宽到 SPEC 的实际要求（e2-5）、按实测重预注册上限（e2-6），以及**重启后的 e2-4**——它把阶段数由 6 扩到 10、再扩到 14，因为 e2-3 基于 n=1 的「6 阶段足够」被 6 次运行的正式批次否证了。

**NX-08e 的正式批次已完成**（十四阶段 × 每臂 3 次重复 × 2 臂，证据在 `.eval-evidence/arm{A,B}-14stage/`，不入库）。逐项证据见 [CHANGES 的 NX-08e 节](CHANGES.md#nx-08e-对照-a全历史-vs-现有裁剪实测)。

**NX-08g0（任务集天花板效应）与 NX-08g（评测报告与结论）均已完成**（2026-10-01，均零付费）。g0 把此前散落各处的旁注展开为判据、机制与补救排序；g 把两次实验合并为读者面向的 [NX-08-REPORT](NX-08-REPORT.md)。**NX-08 的对照 A 这一支到此收尾**，下一步是 NX-08f（对照 B），它必须先单独预注册阶段与整批上限。

**NX-08f（对照 B）已收尾：仪器未成立，以负面结果归档**（2026-10-01，两次烟测共付约 $0.05）。两次烟测都**未观测到处理生效**：模型两次都没有在破损状态下跑过会产生大输出的那份报告（第一次用 `read_file` 分块抽样数据集，第二次改用 6 次 `node -e` 自写探针），峰值估算输入分别是输入目标的 51% 与 41%，最大一条工具结果第二次只有 4,843 字节。**机制可解释且可检验**：给 agent 一个通用 shell，它就能把大数据在**工具进程里**降维成小摘要，不需要读进上下文。**f-5/f-6 不开跑**——自变量从未被触发，预注册没有实测可依。结论并入 [NX-08-REPORT](NX-08-REPORT.md#nx-08f-对照-b仪器未成立)。**不得写成「有界工具输出无影响」**（n=2、两次同侧）；要重测需要换一类**无法被脚本降维**的任务，那是新仪器，不是继续调 `audit`。自变量是**工具输出是否有界**，实现为「同一 `tool-results` 插件、只改 `maxPreviewBytes`」——装/不装会让两臂的 `tools.schema` 相差一个条目，违反 R-21。子步骤：f-1 开关与两臂装配（**done**）、f-2 新增单任务 fixture `audit`（**done**，报告 909 KB ≈ 276,994 估算 token，是输入目标 65,536 的 4.23 倍）、f-3 离线机制证明（**done**，同一装置下无界臂峰值 343,813 token 并 `context_overflow`、有界臂 8,703 token 且通过验收）、f-4 接好诊断阶段 `smoke`（**done**）、**f-4b 付费烟测（done，结论「未观测到处理生效」）**、f-5 按实测预注册 `armC`/`armD`、f-6 正式批次（1 fixture × 6 次重复 × 2 臂）、f-7 报告回填。**f-4b 的结论是「未观测到处理生效」**：模型读 1.4 KB 的 `report.mjs` 源码就拿到全部规则，从未在破损状态下跑过报告，峰值只有输入目标的 51%。**这不是对照 B 的结论**，而是仪器自身两处泄露（`report.mjs` 源码里的 `RULES` 映射；数据行自带的 `expected` 加 `TASK.md` 的提示）——**修完并重跑烟测确认仪器成立之前，f-5 / f-6 都不应开跑**，重跑需单独授权。顺序不可调换：先离线证明开关有效（已完成），再花钱测模型是否产生差异，最后才按实测预注册。详细证据见 [CHANGES 的 NX-08f 节](CHANGES.md#nx-08f-对照-b现有裁剪-vs-裁剪加有界工具输出)。

### NX-08e 报告口径与实测结果

口径先定，再看数据——否则「哪些 run 进分母」会在看到结果之后才被决定。下表是开跑前定下的口径与跑完后的结果。

| 报告项 | 口径 | 实测 |
| --- | --- | --- |
| 两臂通过率 | 分子 = `accepted === true`；分母 = 可计分的 run（排除 `infeasible` 与基础设施 `error`，两者单列） | **6/6，两臂各 3/3。结局饱和**——不可用于比较，见下 |
| 越界位置 | 首次裁剪落在第几个阶段 | armB **8 / 6 / 6**；armA **从不裁剪** |
| 受处理阶段数 | `firstPrunedProjection !== null` 的阶段数 | armB **7 / 9 / 9**（共 14）；armA 0/0/0 |
| 重复间波动 | 逐阶段峰值与整次 token 的极差 | token：armA 1.82 倍（4.86～8.84M）、armB 1.68 倍（2.50～4.20M）；armB 的峰值几乎不动（65,533/65,145/65,314），因为它被输入目标钉住 |
| 每成功任务有效 token | 该臂总 token ÷ 该臂 `accepted` 数 | armA 6,620,335；armB 3,612,683（**45.4% 少**） |
| 延迟与停止原因 | 逐阶段 `activeDurationMs` 之和；`status`／`error` | armA 18.7 分钟、armB 19.6 分钟；**6 次全部 `completed`，零 `max_steps`、零 error** |
| 人工介入 | 自动化批次恒为 0 | 0 |
| provider/estimated 分列 | **报 token，不报条目数** | **508 条 usage 全部 `provider`，`estimated` 为 0**（从 `sessions/*/events.jsonl` 的 `model/usage` 按 `source` 求和） |
| 成本 | 价格页算法、无缓存命中假设 | **约 $4.81**（off-peak；peak 则 $9.61）。两臂时间窗落在 peak 内，但 10-01 为国庆、价格页写明法定假日不计 peak |

**三项曾记为「需另算」的项（编辑失败率、修复迭代次数、token 级分列）现已全部从 `sessions/*/events.jsonl` 算出**，未改 `src/`、未重跑任何一次运行。token 级分列见上表；工具级两项见下。

| 工具级报告项 | 口径 | 实测 |
| --- | --- | --- |
| 编辑失败率 | `file/change-result` 中 `status !== 'applied'` ÷ 全部 `file/change-result` | **6/150 = 4.0%**（armA 3/70、armB 3/80）。六次全是写入保护触发（5 次过期哈希冲突 + 1 次 `oldText not found`），非模型写出坏代码 |
| 修复迭代次数 | **真失败**（`check.mjs` 断言失败的阶段 = 当前阶段）后的再编辑轮次 | **真失败 5 次，全部随后修复（5/5）**，随后的编辑 8 个。armA 1 / armB 4——**n=3 且 4 次里 3 次挤在第 6 阶段，不可读成臂间效应** |
| 探针使用 | `bash` 里含 `node -e` 的自写探针数 | armA 21（1/1/19）、armB 75（18/24/33）；同口径 `check.mjs` 调用 armA 52 / armB 66。方向一致但仍属行为观察 |

**「非零退出的验证」全批 9 次是个会高估的数**：按断言失败的阶段号与当前阶段的关系拆开是 1 次自写探针 + 3 次预期失败（跑了后面的检查）+ 5 次真失败。报告引用修复迭代时必须用后者。`runs.jsonl` 的设计目标是逐阶段预算与裁剪观测，不是工具级统计；引用这几项须说明来源是原始事件。

**成本口径此前用过三种方法，现已统一**：PLAN 的最坏上界（98M token ≈ $43，明写「不是计费承诺」）、`PROGRESS` 里没写推导的历史金额、以及本轮一度从既有花费反推的 $/M。**统一采用价格页直接计算**，并把缓存命中未记录这一已知偏高因素写进报告。历史金额（「约 $0.15／$1／$4」）不可复现，**引用时须按同一算法重算或标注**——本轮就因拿它当基准，把成本报高了约 2～3 倍。

**本批不支持「裁剪是否损害任务成功」的结论**：不是样本量问题，而是二值结局在两臂都取满值（6/6 全通过），没有失败可解释。这与「只有 1 条 fixture 序列」是两个独立的限制，报告须分开写。任务集对这档模型太容易——NX-08d 筛查跑 12/12 是同一个病的另一处表现；该现象已由 **NX-08g0** 展开为判据、边界与补救排序，见 [CHANGES 的 NX-08g0 节](CHANGES.md#nx-08g0-任务集天花板效应定性边界与补救排序)。

| 子步骤 | 内容 | 验收 | 提交边界 |
| --- | --- | --- | --- |
| NX-08d0-1 | 评测预算接入上下文目标与模型窗口能力 | 极小 `inputTargetTokens` 经真实 Harness 跑出 `context_overflow`；适配器未声明 capabilities 时给出明确错误；`pnpm eval:offline` 仍 12/12 | 1 次 |
| NX-08d0-2 | run 结论分类与显式分子分母 | 拒绝但可解、不可行、基础设施失败三类各自进入正确的分子/分母口径 | 1 次 |
| NX-08d0-3 | 逐 run 证据落盘与 `pnpm eval:screening` 真实适配器入口 | 烟测 1 个任务：模型名被接受、回显 `model`、原始 usage 与 `reasoning_tokens` 记录、会话与结果 JSONL 可读回 | 1 次 |
| NX-08d0-4 | d0 文档回填与烟测结论 | 文档记录的命令与实际执行一致 | 1 次 |
| NX-08e0-1 | 修正对照触发条件与需求（文档） | 前置条件改为「会话组成 + 规模」，每处结论可在 `context-runtime.ts:29,68-70`、`session-runtime.ts:135`、`eval-fixture.ts:42-50` 找到依据；27,147 与 17,220 分列；新增 R-21 | 1 次 |
| NX-08e0-2 | 评测驱动支持同一会话内的任务序列 | 描述符支持 `TASKS/*.md` 布局且与 `TASK.md` 互斥；驱动按序 `send` 并逐阶段记录；新增用例证明第三个任务的 `removedTaskIds` 非空且原始事件一条未少；`pnpm eval:offline` 仍 12/12 | 1 次 |
| NX-08e0-3 | 离线量化裁剪触发所需的旧任务规模 | 诊断探针给出「第几次任务开始触发裁剪」的具体数值（实测：固定开销 1,909；每阶段 2,000/8,000/32,000 token 分别在 31/8/2 个阶段触发）；结论回填 PLAN/TASKS/PROGRESS；不调用真实模型 | 1 次 |
| NX-08e1-1 | 新增多阶段依赖 fixture 并让注册表区分筛查批次 | `pipeline` 六阶段：初始失败（退出码 1、AssertionError）、参考解六个阶段全绿、`verify.mjs` 用另一组输入通过；注册表拆出 `screeningIds`/`sequenceIds`，`pnpm fixtures:check` 13 项初始 0/13 参考 13/13、`pnpm eval:offline` 仍 12/12 | 1 次 |
| NX-08e1-2 | 离线覆盖多阶段驱动路径 | 补上 e0-2 声明未覆盖的三条：`runFixtureTask` 走完 6 个阶段且 `counters` 等于各阶段逐字段之和（独立求和，不复用实现的 `sumCounters`）；基础设施失败中止后续阶段且第三阶段正文一次未下发；`phaseCaps.screening.runs === screeningIds.length` | 1 次 |
| NX-08e1-3 | fixture 契约与基线回填 | PLAN 增 fixture 契约与规模依据、TASKS 增子步骤与已完成、CHANGES 增三个小节、PROGRESS 的 fixture 计数与下一步同步；文档数字与实际命令输出一致 | 1 次 |
| NX-08e2-1 | 逐阶段投影观测进入 `RunOutcome.tasks` | 每个阶段给出该阶段最后一次投影的估算输入、投影梯度最大值、投影次数、首次裁剪的投影序号（未裁剪为 `null`）、被移除任务 id 并集、未发出投影数与 usage 来源分列；新增纯函数 `summarizeStage` 的构造式单测，并在 `pipeline` 序列用例上把「未裁剪」断言成确定性事实；`pnpm eval:offline` 仍 12/12 | 1 次 |
| NX-08e2-2 | 真实适配器入口按阶段参数化并修正默认计划清单 | `--phase`（默认 `screening`）与 `--plan-only`（不落盘、不出网、无 key 也能跑）；默认清单改为按阶段注册表取，修掉「不带 `--tasks` 时计划 13 项对 12 次上限」的既有缺陷；`--tasks` 与当前阶段不匹配时报错并点名；`phaseCaps.sequence` 预注册为 runs 1 / requests 192 / tokens 12,000,000 且不计入 `batchCaps` 的 156；新增 `test/eval-cli.test.ts` 与 `pnpm eval:sequence` | 1 次 |
| NX-08e2-3 | `pipeline` 的真实模型烟测与结论回填 | 记录逐阶段估算输入、`firstPrunedProjection`、`removedTaskIds`、停止原因与 usage 来源；判定 6 个阶段是否越过 65,536，被 `max_steps` 截断的阶段单列；PLAN/TASKS/CHANGES/PROGRESS 的数字与 `runs.jsonl` 逐项一致。这一步调用付费模型 | 1 次 |
| NX-08e2-4 | 阶段数确认（按烟测实测） | 原判「无需执行」**已被 n=6 否证**（3 次 armB 只有 2 次真正裁剪，第三次末阶段峰值 50,719 未越界）。重启后把 `pipeline` 由 6 阶段扩到 10、再扩到 14，并按新规模重预注册上限；付费部分只到 10 阶段诊断跑（第 6 阶段首次裁剪、后 5 阶段受处理） | 1 次 |
| NX-08e2-5 | 验收放宽到 SPEC 的实际要求 | `verify.mjs` 不再钉参考解恰好吐出的两句错误措辞，改为断言 SPEC 第 5 节真正要求的「抛 Error 且消息带行号」；参考解补上行号以自洽；新增用例同时证明「换措辞仍通过」与「去掉行号仍失败」，防止放宽退化成空断言；`pnpm fixtures:check` 仍 13/13、`pnpm eval:offline` 仍 12/12 | 1 次 |
| NX-08e2-6 | 按实测重预注册 `phaseCaps` 与单次 run 预算 | `armA`/`armB`/`batchCaps` 按实测（单条六阶段序列 53 请求 / 2,188,159 token）与用户选定的样本量「1 fixture × 3 次 × 2 臂」重算，并逐字写入 PLAN；`pnpm test` 通过。**该步完成前不得开跑对照 A** | 1 次 |
| NX-08e | 对照 A：全历史 vs 现有裁剪 | 前置（2026-09-30 修正）：会话中必须存在**已结束且可裁剪的旧任务**，其累计估算输入还要足以让 `fits` 为假；当前 task 与续跑段恒受保护，加大单个任务无效。筛查跑 12 个 fixture 的单任务会话 `removedTaskIds` 全为空属结构性必然，全部不满足。前置设施见 NX-08e0，任务集见 NX-08e1，规模是否达标由 NX-08e2 的烟测判定。两臂预算一致、样本量为 1 条序列 × 3 次重复 × 2 臂 = 6 次运行（`phaseCaps.armA`/`armB` 各 3 次，NX-08e2-6 已按实测预注册）；报告通过率、回归失败数、编辑失败率、修复迭代次数、人工介入、provider/estimated token 分列、每成功任务有效 token、延迟与停止原因。**样本量只有 1 条 fixture，报告必须写明它不足以支撑需要分母的结论** | 1 次 |
| NX-08f | 对照 B：现有裁剪 vs 裁剪加有界工具输出 | 同 e 的模型、prompt、验收与单次 run 预算；两次比较的结论分开陈述，不合并收益。**不受 e 的会话组成前置限制**：有界工具输出改变的是当前 task 内部的历史规模，单任务会话下就会出现一臂 `context_overflow`、另一臂完成。**本轮没有为它预注册阶段与整批上限**（`phaseCaps` 的 `armA`/`armB` 已明确归属对照 A 的两臂），开跑前须单独预注册。**收尾结论（2026-10-01）：仪器未成立**——两次烟测都未观测到处理生效，模型两次都没在破损状态下跑过报告，而是用 `read_file` 分块或自写 `node -e` 探针把大数据在工具进程里降维。离线装置（同 fixture 同预算同工具序列）确实能分辨（39.5 倍），但**真实模型下自变量从未被触发**，因此 f-5/f-6 不开跑。结论见 [NX-08-REPORT](NX-08-REPORT.md#nx-08f-对照-b仪器未成立) | 1 次 |
| NX-08g0 | 任务集天花板效应：定性、边界与补救排序 | 判据是**方差为零**（NX-08d 12/12 与 NX-08e 6/6 都没有可用变异），与样本量是两个独立限制；机制三条可核对（公开受保护的 `check.mjs` 且十四个阶段说明全都给出该命令、收敛都在同阶段内完成、预算从未成为约束）；列出不该写的结论与五个补救方案的成本排序。**不调用付费模型、不改 `src/` 与 fixture**，方案 2～5 本轮一条都不执行 | 1 次 |

### NX-09 README 定位、原创增量、架构图与零密钥运行入口

**已完成（2026-10-01，零付费）**。M9 的入口件，也是路线图「M5～M7 加最小 M9 演示即可形成投递版本」里唯一还缺的那一块。**触发条件已成立**：路线图 M7 出口要求一条命令可重跑离线评测加真实模型对照报告，NX-08 已交付 [NX-08-REPORT](NX-08-REPORT.md)；此前拦住本项的「真实模型结果一节须等 NX-08 完成后回填」随之解除。

M9 出口要求「陌生读者能按说明运行并检查最终文件/测试；项目介绍清楚区分**教程基线、独立扩展、真实模型结果与模拟回归**」——下表逐步对齐这四件事。**只改文档、零付费**：不碰 `src/`，不改 `docs/INTERNSHIP_ROADMAP.md`（其状态段陈旧另立待办，见 NX-09-6）。任务名里的「5 分钟」承诺的是**零密钥与可复现**，不是墙钟时长——冷启动安装的耗时无命令可验，故 README 不写时长。

| 子步骤 | 内容 | 验收 | 提交边界 |
| --- | --- | --- | --- |
| NX-09-0 | TASKS 立项：NX-09 子步骤表（**done**；本行标记随 NX-09-1 补记——该步是建表本身，当时没有可回填的行状态） | `grep -cE '^\| NX-09-' docs/context-budget/TASKS.md` = 7；每行「验收」列至少含一个反引号命令或 `git`/`grep` 判据；`git diff --stat` 只含 `docs/context-budget/TASKS.md` | 1 次 |
| NX-09-1 | README 开篇：定位与范围/非目标（**done**） | `grep -c '结构化验证记录仍是后续规划' README.md` = 0（NX-15 已交付该能力，旧句随本段一并删除）；`grep -c '不支持 MCP' README.md` = 0（README 已记录可选 Context7 MCP）；三段齐备，非目标每一条都能在 `PLAN.md` 的 D-01 或路线图 §4.7 找到依据 | 1 次 |
| NX-09-2 | README 开篇：教程基线与独立扩展分界（**done**） | 分界表每条附可复现命令且实跑一致：`git ls-tree -r --name-only c5fc9c4 \| grep -c '\.ts$'` = 0、`git ls-tree -r --name-only c5fc9c4 src/ \| wc -l` = 22、基线 6 个工具（`git show c5fc9c4:src/tools/files.js` 五个 + `bash.js` 一个）、基线 22 条测试（core 20 + integration 2）、本项目起点为 `43e3829`（CB-00）；README 不出现「第 N 天 ↔ CB-xx」的映射 | 1 次 |
| NX-09-3 | README/PROGRESS 陈旧数字与过时表述订正（**done**） | `grep -nE '当前 [0-9]+ 条测试' README.md` 只有一处且数字等于 `pnpm test` 实测（200）；README 的 `tools/` 工具清单与实际注册的 9 个一致（补 `request_trace`、`task_report`）；README 同时出现「NX-05b 的 12 项」与「当前注册表 14 项 = 筛查 12 + pipeline + audit」，而 `eval:offline`/`eval:screening` 处仍为 12；PROGRESS 的主分支基线条改为 200/200 与 14 项，带日期的历史条（`198/198`）与 README 的 SHA 锚定历史（`147/147`、`check72/test123`）逐字不变 | 1 次 |
| NX-09-4 | README 结构节增加 Mermaid 架构图（**done**） | mermaid 围栏恰好 1 个，且 `grep -c '^```' README.md` 为偶数（围栏配对）；图内工具名集合与 `grep -o "name: '[a-z_]*'" src/tools/*.ts src/plugins/*.ts` 一致，其中 `tools/` 的 9 个与插件提供的 2 个在图中可区分；只表达三件事——请求路径、事件日志是唯一事实来源且投影由其派生、工具在两处注册；**不安装新依赖做渲染校验**，渲染由 GitHub 承担 | 1 次 |
| NX-09-5 | README 零密钥上手路径（**done**） | 在未设 `DEEPSEEK_API_KEY` 的环境逐条实跑且退出码 0：`pnpm install --frozen-lockfile` → `pnpm check`（`syntax ok: 84 files`）→ `pnpm test`（`pass 200` / `fail 0`）→ `pnpm fixtures:check`（14 项，初始全失败、参考全通过）→ `pnpm eval:offline`（12 planned / 12 accepted）；README 记的每个数字与实跑输出逐字一致；该块内不出现 `pnpm start`；`grep -nE '[0-9]+ ?分钟内\|分钟跑完' README.md` 输出为空 | 1 次 |
| NX-09-6 | README 实验报告一节 + TASKS/CHANGES/PROGRESS 回填（**done**） | 链 `docs/context-budget/NX-08-REPORT.md` 且锚点在文件内匹配；**该节内** `grep -nE '提升\|提高\|优于\|更好\|最好\|显著\|效率\|收益\|成功率\|%'` 输出为空（**故意严格**：连「token 少 45.4%（非效率提升）」这种带免责的写法也不写，直接链报告不复述数字）；把「结局饱和（方差为零）」与「样本量小」写成两条独立限制并引 NX-08g0 判据；教程基线／独立扩展／真实模型结果／模拟回归四类分列；回填的命令与实际输出一致 | 1 次 |

### NX-10 固定代码修复演示（三幕，零付费）

**已完成（2026-10-01，零付费）**。路线图 M9 在 NX-09 之后剩下的两块之一（另一块是 NX-11 的设计取舍整理）。M9 出口要求「陌生读者能按说明运行并检查最终文件/测试」——NX-09 给的是「怎么跑起来」，本项给的是「跑起来能看见什么」。

「固定」指**预设脚本化模型**而非真实模型：三条演示都只向本地注册 `scripted` 适配器、从不 import `src/index.ts`，因此不读 `.env`、不出网、不调用付费 API，逐字可复现。**不改 `src/`**，也不改 `docs/INTERNSHIP_ROADMAP.md`（其状态段陈旧归 NX-20）。

立项前核实的三个缺口：① `scripts/` 下没有任何读者面向的入口；② **项目规则这一段在演示路径上根本不存在**——规则源只有 `AGENTS.md`（`src/core/project-context-runtime.ts:122`），14 个 fixture 的 `initial/` 里一个都没有，而 `scripts/eval-fixture.ts:96-101` 的 `runFixtureTask` 也不装载 `runtime-context` 与 `project-context`；③ 预算停止/恢复、unknown、diff 与证据三块各自有测试（`coding-fixtures.test.ts:295`、`store.test.ts:44`、`task-*.test.ts`），但从未被串成读者能看的叙事。

一条必须照实写的发现：**子进程被杀会留下 `writer.lock`**，而 `JsonlStore.open` 对任何已存在的锁一律拒绝（`src/core/event-store.ts:40`）、`quarantineTail` 也要先抢同一把锁（`:17-20`），因此恢复的**唯一路径是先由人删掉该锁**，`src/plugins/cli.ts:36-40` 的启动恢复也没有对应入口。第三幕照实演示这一步，并据此另立 **NX-21**，本次不修。

| 子步骤 | 内容 | 验收 | 提交边界 |
| --- | --- | --- | --- |
| NX-10-0 | TASKS 立项：NX-10 子步骤表（**done**） | `grep -cE '^\| NX-10-' docs/context-budget/TASKS.md` = 9；每行「验收」列至少含一个反引号命令或可判定的退出码/`grep` 判据；`git diff --stat` 只含 `docs/context-budget/TASKS.md` | 1 次 |
| NX-10-1 | 演示 fixture `repair` 与 `demoIds` 注册表（**done**；本行标记随 NX-10-2 补记——该步是提交 `92b64ef` 本身，当时没有可回填的行状态） | `pnpm fixtures:check` 输出 15 行且 `expected` 全为真；`repair` 初始态退出码**恰为 1**（`check-coding-fixtures.ts:10` 的判据）；两份 `AGENTS.md`、`check.mjs`、`src/legacy/cart.mjs` 均不在 `sources.repair` 内因而进受保护集合；`test/eval-runner.test.ts:398` 的筛查/序列上限断言不受影响 | 1 次 |
| NX-10-2 | `repair` 三态基线用例（**done**） | `pnpm test` 201/201（新增 1 条）：初始失败（退出 1）、只应用 `partial/` 仍失败、应用 `reference/` 通过；改写任一受保护文件后该验收不通过 | 1 次 |
| NX-10-3 | 第一幕 `pnpm demo:fix`（**done**） | `pnpm demo:fix` 退出 0，且输出含系统提示四个 section 与顺序、`project_context` 返回的**作用域**规则、失败检查的原始输出、`task_changes` 的非空确认 diff、`task_report` 的 `[Run]`/`[File]`/`[Check]` 行、独立验收 `acceptance passed: repair`；任一不成立则退出 1 并点名 | 1 次 |
| NX-10-4 | 第二幕 `pnpm demo:resume`（**done**） | `pnpm demo:resume` 退出 0，且输出含 `max_steps`、在途工具的 `status:'skipped'`、`continuations === 1`、逐 `toolCallId` 无重复执行、两段 run 的 `previous=` 关系、最终独立验收 | 1 次 |
| NX-10-5 | 第三幕 `pnpm demo:unknown`（**done**） | `pnpm demo:unknown` 退出 0，且：子进程被 `taskkill /T /F` 异常终止；`JsonlStore.open` 先以 `/session writer lock exists/` 失败；显式 `unlink` 后重开成功；`restore` 合成恰好一条 `status:'unknown'`；`events.jsonl` 行数因此增加（证明合成落盘）；`.demo-side-effect` 仍在；`agent.continue()` 以 `/unknown tool outcome/` 被拒；连跑两次均退出 0 | 1 次 |
| NX-10-6 | 陈旧会话锁的显式恢复路径用例（**done**） | `pnpm test` 202/202（新增 1 条）：日志停在 `tool/start` 且目录残留 `writer.lock` 时 `open` 拒绝、`unlink` 后重开成功、`restore` 得恰好一条 `unknown`、副作用文件未被触碰、`continue()` 被拒；**子进程杀进程那半不写进用例**（平台相关），只把它之后确定性的断言写进用例 | 1 次 |
| NX-10-7 | 演示一节与计数订正（**done**） | README 新增 `## 演示`，其中每条命令与实测输出逐字一致；`grep -nE '当前 [0-9]+ 条测试' README.md` 只有一处且等于 `pnpm test` 实测；README／`test/fixtures/coding/README.md`／PROGRESS 的 `84→89` 文件、`200→202` 测试、`14→15` 项三处计数与实跑一致；带日期的历史证据（README 的 SHA 锚定行、`PROGRESS.md:7` 的 NX-09 条、NX-09 各行、CHANGES 各处）逐字未动 | 1 次 |
| NX-10-8 | TASKS/CHANGES/PROGRESS 回填与 NX-21 立项（**done**） | 各行置 `done` 并记提交号；CHANGES 增 NX-10 节且命令与实际输出一致；PROGRESS 的当前状态与下一步同步；NX-21 在 TASKS/PROGRESS 均出现 | 1 次 |

### NX-11 整理设计取舍（五节，零付费）

**已完成（2026-10-01，零付费）**。路线图 M9 的最后一块（`docs/INTERNSHIP_ROADMAP.md:227`）：

> `NX-11`：整理设计取舍：事件与投影分离、协议完整性、可靠编辑、验证时效和未知副作用恢复。**能从代码和测试解释选择**。

NX-09 给的是「怎么跑起来」，NX-10 给的是「跑起来能看见什么」，本项补的是**「为什么这么选，以及这个选择被钉在哪里」**，同时把路线图 §6 那七条「建议能回答的追问」接到可核对的位置上。

立项前核实的三个缺口：① PLAN 的 D-01…D-11 与 NX-13/NX-15 决策节**写下了选择**，却通篇没有一条代码锚点或测试锚点——「能从代码和测试解释选择」这句话当前在仓库里无法被任何人核对；② 五条主题散落在 PLAN、REQUIREMENTS 与 README 的四个功能节里，要拼五处才拼得出一条完整回答；③ 没有任何一份文档把「追问 → 选择 → 替代方案 → 锚点」串起来。

**约束**：`AGENTS.md:10` 写明 PLAN 是「技术取舍」的唯一维护位置，因此新文档定位成**非规范性说明**——不复述数值、不重定义决策编号，决策本身一律指向 PLAN，自己只给「替代方案的**具体**失效 + 代码锚点 + 测试锚点 + 代价」。

**设计要点**：锚点写成固定列数的表格（`| 类型 | 锚点 | 它钉住什么 |`），由一条回归测试机读，只处理表格行、不解析散文；每节必须各有一行 `代码` 与一行 `测试`，不允许某节静默退化成纯散文。另一条约定是**每条「替代方案」标注来源**（`【决策时记录】`／`【事后重构】`），使读者能区分当初真的权衡过的理由与会后补充的理由。

**不改 `src/`**，也不改 `docs/INTERNSHIP_ROADMAP.md`（其状态段陈旧归 NX-20）。

| 子步骤 | 内容 | 验收 | 提交边界 |
| --- | --- | --- | --- |
| NX-11-0 | TASKS 立项：NX-11 子步骤表（**done**） | `grep -cE '^\| NX-11-' docs/context-budget/TASKS.md` = 9；每行「验收」列至少含一个反引号命令或可判定的 `grep`/退出码判据；`git diff --stat` 只含 `docs/context-budget/TASKS.md` | 1 次 |
| NX-11-1 | 建 `DECISIONS.md`：开头与第 1 节「事件与投影分离」（**done**） | 文件存在；`grep -c '^### ' docs/context-budget/DECISIONS.md` = 1；该节锚点表至少各有一行 `\| 代码 \|` 与 `\| 测试 \|`；开头写明「回答什么／不回答什么」「锚点约定」「来源标注约定」三件 | 1 次 |
| NX-11-2 | 第 2 节「协议完整性」（**done**） | 该节锚点的每条 `file:line` 与测试名逐条 `grep` 命中，命令与输出记入 CHANGES；该节锚点表仍含代码与测试各一行 | 1 次 |
| NX-11-3 | 第 3 节「可靠编辑」（**done**） | 同上 | 1 次 |
| NX-11-4 | 第 4 节「验证时效」（**done**） | 同上 | 1 次 |
| NX-11-5 | 第 5 节「未知副作用恢复」与结尾总表（**done**） | 同上；结尾总表覆盖全部五节，并标明哪几节有可跑演示、其余明确写「无对应演示」 | 1 次 |
| NX-11-6 | 锚点回归测试与计数订正（**done**） | `pnpm test` 203/203（新增 1 条）、`pnpm check` 90 文件；**反例实跑**：把某条代码锚点的行号改成越界值后 `pnpm test` 必须红，改回必须绿（命令与输出记入 CHANGES）；README 与 PROGRESS 的 `89→90` 文件、`202→203` 测试与实跑逐字一致 | 1 次 |
| NX-11-7 | 三处入口指引（**done**） | README、PLAN 的「设计决策及取舍」节首行、`AGENTS.md` 文档入口列表各有一行指向 `DECISIONS.md` 且目标存在；README 的零密钥命令条数不变（本次不新增命令） | 1 次 |
| NX-11-8 | TASKS/CHANGES/PROGRESS 回填（**done**） | 各行置 `done` 并记提交号；CHANGES 增 NX-11 节且命令与实际输出一致；PROGRESS 的当前状态与下一步同步 | 1 次 |

NX-11-2…NX-11-5 这四步的验收**弱于** NX-11-6：那时锚点回归测试还不存在，只能逐条 `grep` 人工核对。这一点照实写进 CHANGES，不假装每步都有同等强度的验收。

### NX-08h 打破任务集天花板（方案 2，无公开检查变体）

**已完成（2026-10-01；离线部分零付费，付费烟测约 $1.43）。结果：未观测到失败，另暴露预注册的一处缺口。** 用户选定「只做方案 2」。承接 [NX-08g0](CHANGES.md#nx-08g0-任务集天花板效应定性边界与补救排序) 的**方案 2**：「增设**无公开检查**变体：工作区不含 `check.mjs`，只能按 SPEC 自验」。NX-08g0 判定的天花板效应是——两处独立测量都取满值（NX-08d 筛查 12/12、NX-08e 对照 A 6/6），**方差为零**，以 `accepted` 为分子的通过率统计量**没有分辨力**。机制之一是**公开且受保护的 `check.mjs` 就在工作区里、十四个阶段的说明全都给出 `node check.mjs N` 这个命令**，模型不必一次写对，只需能收敛到绿。

**它测的是另一件事。** 现有 fixture 测「有完整、即时、廉价 oracle 时能否收敛」；去掉 oracle 之后测的是「能否按 SPEC 独立产出正确实现」。

**实现方式：新建 fixture `blind`。** 从 `pipeline` 机械复制十四阶段，**只改三处**：删掉 `initial/check.mjs`、十四份阶段说明的末句改为按 `docs/SPEC.md` 自验、`docs/SPEC.md` 里两处提到 `check.mjs` 的句子改为只提独立验收。模型、prompt、初始工作区、验收器、单次 run 预算与输入目标 65,536 都与 NX-08e 的 `armB` 一致，**唯一差异是没有公开 oracle**——因此与既有读数可比。

**为什么不给 `runFixtureTask` 加「隐藏 check.mjs」开关**：`protectedFiles` 在 `createFixture` 时按 `initial/` 快照，删掉受保护的 `check.mjs` 会让 `passed` 恒为 false，除非再去特判验收器——那正是在改独立验收口径来配合隐藏文件。新建 fixture 让处理在 fixture 树里可见可评审，且对 `.eval-evidence` 里六个历史目录零扰动。

**为什么不并入 `sequenceIds`**：`repeatCount(1, 2)` 会抛 `cannot be split evenly across 2 fixtures`（`eval-cli.ts:83-88`），且 `phaseRegistry('armA') === ['pipeline']` 的既有断言会红。因此新增第五份注册表 `blindIds`。新阶段 `blind` 是**诊断烟测**，与 `smoke` 同口径：不进 `batchPhases`、`batchCaps` 保持 `{18, 3_200, 88_000_000}` 不变。

**约束**：`src/` 一行不动；**不得沿用本轮的 `phaseCaps` 数字**——`blind` 的 cap 取逐阶段预算的理论上界（14 × 32 / 14 × 2,000,000），是机械推导而非实测预注册；`blind` 上的正式对照批次留到烟测之后另行授权。**反 p-hacking 条款**：无论烟测结果如何都不再改 fixture，继续调直到出现预期分叉即按结果挑仪器（红线沿用 NX-08f-4c）。

| 子步骤 | 内容 | 验收 | 提交边界 |
| --- | --- | --- | --- |
| NX-08h-0 | TASKS 立项与 PLAN 预注册节（**done**） | `grep -cE '^\| NX-08h-' docs/context-budget/TASKS.md` = 9；每行「验收」列至少含一个反引号命令或可判定的 `grep`/退出码判据；PLAN 新节写死规模、可比性、三条判据（打破／因其它原因被拒／未被打破）与「无论结果如何不改 fixture」；`git diff --stat` 只含两份 `docs/context-budget/` 文件 | 1 次 |
| NX-08h-1 | 建 `blind` fixture 骨架与注册表（**done**） | `test/fixtures/coding/blind/` 存在且 `initial/` 下**无** `check.mjs`；`blind/verify.mjs` 与 `pipeline/verify.mjs` **仅 marker 一行不同**（`diff` 输出恰为该行）；`grep -c blindIds scripts/coding-fixtures.ts` ≥ 2；`sources.blind` 与 `sources.pipeline` 逐字相同；`pnpm check` 通过 | 1 次 |
| NX-08h-2 | 改写阶段说明与 SPEC（**done**） | `grep -rln 'check\.mjs' test/fixtures/coding/blind/initial test/fixtures/coding/blind/TASKS` **输出为空**；`grep -c '^\| NX-08h-' docs/context-budget/TASKS.md` 不变；十四份 `TASKS/*.md` 与 `pipeline` 对应文件的差异**只在末段**（`diff` 逐份核对记入 CHANGES）；文本不含「变体」等元信息 | 1 次 |
| NX-08h-3 | 阶段枚举与上限（**done**） | `pnpm test` 中 `pre-registered caps match PLAN…` 用例绿且 `batchCaps` 仍为 `{18, 3_200, 88_000_000}`；`grep -n "'blind'" scripts/eval-runner.ts scripts/eval-cli.ts` 各至少命中 `PhaseName`／`phaseCaps`／`phaseNames`／`phaseRegistry` 四处；无 default 的 switch 经 `pnpm check` 证明穷尽 | 1 次 |
| NX-08h-4 | `blind` 契约与机制证明用例（**done**） | `pnpm test` 新增用例全绿，其中机制证明断言：`blind/initial/` 无 `check.mjs`、`initial/` 与 `TASKS/` 文本不含 `check.mjs`、两份 `verify.mjs` 仅 marker 一行差、十四份阶段说明与 `pipeline` 只差末段；注册表五份数组两两互斥；`phaseRegistry('blind')` 逐字等于 `['blind']` | 1 次 |
| NX-08h-5 | 离线机制证明（零付费，**done**） | `pnpm fixtures:check` **16 项、初始 0/16、参考 16/16**；`pnpm test` 全绿；`pnpm check` 90 文件；`pnpm eval:offline` 仍 12/12；三条 `demo:*` 退出 0；**反例实跑**：`blind/verify.mjs` 的 marker 改回 `pipeline` 后 `pnpm fixtures:check` 必须红，改回必须绿（命令与输出记入 CHANGES） | 与 NX-08h-6 同一次（本步不产生文件改动，证据直接写进 CHANGES 的 NX-08h 节） |
| NX-08h-6 | 文档回填（离线收尾）（**done**） | CHANGES 增 NX-08h 节且命令与实际输出逐字一致；各行置 `done` 并记提交号；README／`test/fixtures/coding/README.md`／PROGRESS 的 `15→16` 项计数与实跑一致，`syntax ok: 90 files` 不变；带日期的历史证据逐字未动 | 1 次（NX-08h-5 的证据一并在此） |
| NX-08h-7 | 付费烟测（**done**） | `pnpm eval:screening --phase blind --plan-only` 输出含 `1 个任务 × 1 次重复 = 1 次运行：blind`、`448 请求 / 28000000 token`、末行 `只做计划预演，未建立目录、未发出请求`；随后 `MINI_DSH_EVAL_EVIDENCE_DIR=.eval-evidence/blind-full pnpm eval:screening --phase blind` 退出码与逐阶段读数落盘 | 1 次 |
| NX-08h-8 | 报告回填（**done**） | CHANGES 结果节含 `acceptance.output` 原文、逐阶段 `status`、`protectedFilesChanged`、是否出现 `max_steps`；结论按 PLAN 预注册的三条判据分类，n=1 只作存在性证据，不含任何比例或提升措辞（`grep -nE '提升\|提高\|优于\|更好\|显著\|效率\|收益\|成功率\|%'` 在新增报告节内输出为空） | 1 次 |

NX-08h-1／NX-08h-2 的全部内容是从 `pipeline` 机械复制后的改写，**验收只在事后核对差异范围**，不像 NX-11-6 那样有回归测试在写的时候挡住漂移——这一点照实写进 CHANGES。

**提交**：`75a4614`（NX-08h-0）、`9bfafb4`（NX-08h-1）、`32efaf3`（NX-08h-2）、`a1d1077`（NX-08h-3）、`935b769`（NX-08h-4）、NX-08h-5＋NX-08h-6（合并一次），以及本提交（NX-08h-7＋NX-08h-8）。详细证据见 [CHANGES 的 NX-08h 节](CHANGES.md#nx-08h-打破任务集天花板方案-2无公开检查变体)。

**结论（2026-10-01，付费约 $1.43）**：单次运行 `accepted`、退出码 0、输出逐字 `acceptance passed: blind`、受保护文件零改动、**零 `max_steps`**——按预注册字面命中**「未被打破」**，只可写「这一次没有失败」。222 请求 / 256 工具 / 8,710,662 token / 约 21.4 分钟，usage 全部来自 provider。**两处必须照实写的事实**：① **4/14 个阶段以 `context_overflow` 结束**（第 6、7、13、14），触发点是**输入目标** 65,536 而非窗口，且发生在裁剪到底之后——**预注册的判据只防了 `max_steps`，这是它的缺口**，判据正文逐字未改，缺口记在 CHANGES 与 PLAN 的追记里；② 模型**自建了检查脚本**（`tmp-verify-06.mjs`／`tmp-verify-07.mjs`，第 10 阶段还回头复用了一次），117 次 bash 里 31 次是 `node` 内联脚本，而提到 `check.mjs` 的**是 0 次**。**不得**写成「无公开检查不影响结果」，**不得**与 `armB` 并排读（本次是诊断烟测，与 `armB` 的比较不在预注册内），**不得**据此改 `blind` 或重跑。

### NX-19 出网拦截的真实缺口收口

**done（2026-10-01，零付费）。方向是「加强」而非「放宽」**：NX-17 把误拒的惰性形状放行，本轮把**能真正取网、而闸门当前放行**的形状判为拒绝。诊断矩阵 `docs/context-budget/nx17-gate-probes.mjs:43-46` 已登记其中四条（`known gap NX-19`），本轮把它们搬进约定组。**NX-17 记为「未放宽」的规则本次一行不动**——`..` 整串正则、系统路径、工作区外路径、递归删除、`sudo` 与「惰性输出接进管道」的处理全部保持。

**为什么不是「见到 `$(` 就拒」**：`src/tools/bash.ts:53` 把模型给的整串命令交给 `bash -lc`（`src/core/command-runner.ts:56` 是 `spawn(exe, ['-lc', command])`），所以 `$(...)`、反引号与 shell 的 `-c` 参数是**真的会被执行**的文本，而顶层分词恰恰看不见它们。判据取「这段文本会不会被执行」，把这类片段抽出来**递归检查**；按出现位置拒绝会误伤 `echo "$(date)"`。递归保留 allowHosts 语义——`bash -c "curl http://localhost/health"` 必须放行。

**本次唯一的净放宽**：`curl -o out.txt http://localhost/x` 这类今日被误拒（既有「裸主机名操作数」规则把 `-o` 的**取值**当成了主机；实测 `wget -O page.html`、`curl -sS -o out.json` 同样）。它违背 `CHANGES.md:855` 已记录的意图，且不先修就会把同类误报复制到 `ssh -i`／`scp`／`rsync`，因此**独立成一步、排在清单扩展之前**。

**不承诺闭合**：取网工具集是尽力而为的清单，形状启发式不是完备解析。`node -e`／`python -c` 的程序字符串、脚本文件内容、base64 解码后进 shell、here-doc 正文与未列入的工具都不在覆盖内，逐条写进 R-20 的边界句。

| 子步骤 | 内容 | 验收 | 提交边界 |
| --- | --- | --- | --- |
| NX-19-0 | 立项、PLAN 决策与边界句订正（**done**） | `grep -cE '^\| NX-19-' docs/context-budget/TASKS.md` = 7；每行「验收」列至少含一个反引号命令或可判定的 `grep`/退出码判据；PLAN 新增 `D-12` 且写明上限（深度 3／片段 32）与「清单只减少漏报、不承诺闭合」；R-20 的边界句不再声称出网规则「只覆盖可识别命令段内」的 URL 形态；`git diff --stat` 只含 `docs/context-budget/` 三份文件 | 1 次 |
| NX-19-1 | 取网工具的非目标取值旗标（**done**） | `curl -o out.txt http://localhost/x`、`wget -O page.html http://localhost/`、`curl -sS -o out.json http://localhost/api` 由 deny 变 allow；`curl --url example.com`、`curl -s example.com`（默认仍检查）、`curl -o /etc/cron http://localhost/x`（路径检查保留）仍 deny；`pnpm test` 全绿 | 1 次 |
| NX-19-2 | 工具集扩展与主机操作数形态（**done**） | `nc example.com 80`、`ssh user@example.com`、`scp report.pdf user@example.com:/tmp/`、`rsync -avz src/ example.com:/dest/`、`ping example.com` 由 allow 变 deny；`ssh -i key.pem localhost`、`nc -l 8080`、`ping 127.0.0.1`、`curl http://localhost:8080/health` 仍 allow | 1 次 |
| NX-19-3 | 嵌套文本递归检查：`$(...)` 与反引号（**done**） | `echo "$(curl https://example.com)"`、反引号形式、`x=$(curl https://example.com)`、`node -e "…; $(curl http://example.com)"` 由 allow 变 deny 且理由带 `in command substitution:` 前缀；`echo '$(curl …)'`、`echo \$(curl …)`、`echo $((1+2))`、`echo "$(curl http://localhost/health)"` 仍 allow；超深／超量按上限理由拒绝且**与出网理由不同串**；引号区间一致性用例绿 | 1 次 |
| NX-19-4 | shell `-c` 与 `eval` 的脚本参数抽取（**done**） | `bash -c 'curl http://example.com'`（单引号形式）、`bash -lc "curl …"`、`bash -c -- "curl …"`、`env bash -c '…'`、`xargs bash -c '…'`、`eval "curl http://example.com"` 由 allow 变 deny；`bash -c "echo hi"`、`bash -c 'echo hi' example.com`（只取一个 token）、`echo bash -c "curl x"` 仍 allow | 1 次（复用 NX-19-3 的递归底座） |
| NX-19-5 | 反斜杠 UNC（**done**） | `cat \\server\share\secret`、`cat "\\server\share"`、`cat \\?\C:\Windows\win.ini` 由 allow 变 deny 且理由为 `UNC path is blocked`；`printf '\\n'` 仍 allow | 1 次 |
| NX-19-6 | 契约、矩阵与回填（**done**） | 4 条 `known gap NX-19` 行**先跑到 `met` 留证**再搬进约定组，重跑**无 `drift`** 且新组全 `ok`；R-20 正文与验收补新条目、边界句逐条列出不可闭合的旁路；CHANGES 增 NX-19 节且命令与输出逐字一致；NX-23／NX-24 在 TASKS／PROGRESS 均出现；`pnpm check` 90 文件、`pnpm test` 全绿、`pnpm fixtures:check` 16 项、`pnpm eval:offline` 12/12 | 1 次 |

**提交**：`8ad5765`（NX-19-0）、`371eec9`（NX-19-1）、`fc23fcb`（NX-19-2）、`d2a045f`（NX-19-3）、`5e1f99c`（NX-19-4）、`8aacdf0`（NX-19-5），以及本提交（NX-19-6 回填）。详细证据见 [CHANGES 的 NX-19 节](CHANGES.md#nx-19-出网拦截的真实缺口收口)。

### NX-24 闸门词法偏差的误拒收口

**done（2026-10-01，零付费）**。NX-19 修的是「真正会执行的文本被顶层分词漏掉」（方向是**加强**）；本项修反面——**闸门自己的词法与真实 shell 不一致，把数据当成了路径或变量**（方向是**放宽**）。NX-17／NX-19 记为「未放宽」的那批规则（`..` 整串正则、系统路径、工作区外路径、软链、递归删除、`sudo`、UNC、出网与 allowHosts）本项**一行不动**。

**证据是实测的，不是推断。** 把 `.eval-evidence/` 下 33 份 `events.jsonl` 里 **782 次真实模型 bash 调用**逐条取出，按**各会话自己的 workspace**（从 `tool/result` 的 `cwd` 读回）重放到 `dist`：**32 条被拒**（`pnpm build && node docs/context-budget/nx24-replay-probe.mjs`）。

> **方法学陷阱（本次实测踩过）**：改用 `process.cwd()` 当 workspace 重放会得到 **64** 条，其中 32 条是**重放自身的伪影**——模型在评测里 `cd "C:\…\mini-dsh-fixture-*/workspace"`，而闸门的 workspace 就是那个临时目录。必须按会话读回 `cwd`，否则结论凭空翻倍。

逐条归因（每条都用 bisect 定位过触发点）：

| 族 | 条数 | 形状（原文） | 判定 |
| --- | --- | --- | --- |
| ① `for` 绑定变量 | **18** | `for f in src/*.mjs; do echo "=== $f ==="; cat "$f"; done`；`for n in 07 08 09 10; do node tmp-verify-$n.mjs > r$n.log 2>&1; echo "$n exit=$?"; done`；`for f in delta plan-parse plan-merge; do cat "src/$f.mjs"; done` | 误拒 |
| ② 反斜杠转义 | **2** | `node -e "…Array.from({length:2000},(_,i)=>\`n\${i}: n\${(i+1)%2000}\`).join('\n')…"`；`sed -n "$(grep -n '^## 11' docs/SPEC.md \| cut -d: -f1),\$p" docs/SPEC.md` | 误拒：`\$` 已转义，bash 不展开 |
| ③ 单引号内的 `$NAME` | **1** | `node --input-type=module -e '…throws("a: b$c\n", …)…'` | 误拒：单引号内 bash 不展开 |
| ④ 被引号成词的正文以 `/` 开头 | **5** | `awk '/^## 11/,/^## 12/' docs/SPEC.md`；`sed -n '/^## *9/,/^## *10/p' docs/SPEC.md`；`grep … \| awk '/stage\(7\|7\)\|phase 7/{f=1} f' check.mjs` | 误拒：awk／sed 程序正文被当成绝对路径 |
| ⑤ **必须继续拒绝（真阳性）** | **2** | `node -e "… show('a: b$ad'); …"`；`node -e "… ['a: b $c', /line 1[\s\S]*/] …"` | **拦对了**：`$ad`／`$c` 在**双引号内且未转义**，bash 真的会展开成空串、静默改坏模型写的程序 |
| 残留（另立项，本项不修） | 4 | `/tmp/…` ×2；`node --input-type=module <<'EOF'` ×1；一条触发点待定位 ×1 | 见 NX-25／NX-27／NX-28 |

**它改变了模型的行为**（原始事件里模型的自述，非推断）：`"Hmm, the bash tool rejects $f? Let me just cat each file."` 与 `"the tool reports \"unset environment variable in command\" … Let me write a temp test script file instead."`

**根因是一条，不是四条**：`:290` 的环境展开是**引号盲、反斜杠盲**的全局 `String.replace`（对**本串内刚绑定过的**名字也一无所知）；`:386` 的路径形态判据只认「两条以上前导斜杠 ＋ 首分量含空白」。所以修法是**一趟引号与转义感知的扫描**替换前者，再把后者的「前导斜杠条数」这一维去掉。

| 子步骤 | 内容 | 验收 | 提交边界 |
| --- | --- | --- | --- |
| NX-24-0 | 立项与契约订正（**done**；本行标记随本提交补记——该步就是本表本身） | `grep -cE '^\| NX-24-' docs/context-budget/TASKS.md` = 7；每行「验收」列至少含一个反引号命令或可判定的 `grep`/退出码判据；PLAN 新增 `D-13`；R-20 的边界句不再声称「单引号内的 `$NAME` 仍被环境展开、shell 变量被当未定义环境变量」，「双斜杠形态」改为「任意前导斜杠形态」；NX-25／NX-26／NX-27／NX-28 在 TASKS 均出现；`git diff --stat` 只含 `docs/context-budget/` 三份文件 | 1 次 |
| NX-24-1 | 反斜杠转义：`\X` 整对复制（族②）（**done**） | `echo \$HOME`、`echo "\$HOME"`、`sed -n "…,\$p" …` 由 deny 变 allow；`echo \$(curl http://example.com)` 仍 allow、`echo \\$(curl http://example.com)` 仍 deny；**反例**：把 `\X` 整对复制改成单字符前进后对应用例变红 | 1 次 |
| NX-24-2 | 引号感知：单引号内不展开（族③）（**done**） | `echo '$HOME'`、`node --input-type=module -e '… $c …'` 由 deny 变 allow；`cat "$HOME/.ssh/id_rsa"` 仍 deny、`cat "$HOME/mini-dsh-workspace/file"` 仍 allow、`cat $MINI_DSH_TEST_ROOT/../etc/passwd` 仍 deny；**两条真阳性**（`show('a: b$ad')`、`['a: b $c', …]`）仍 deny 且理由为 `unset environment variable`；**反例**：关掉单引号分支后 `echo '$HOME'` 变红 | 1 次 |
| NX-24-3 | 波浪号折进同一趟扫描（**done**） | `echo '~'` 由 deny 变 allow；`rm -rf ~`、`cat ~/.ssh/id_rsa` 仍 deny；CHANGES 写明**此前无任何测试或证据覆盖 `~`**，故独立成提交以便单独 revert；**反例**：把 `~` 还原成引号盲的那句 `replace` 后对应用例变红 | 1 次 |
| NX-24-4 | 命令内绑定：`for NAME in …` 与 `NAME=<字面量>`（族①）（**done**） | 18 条 `for` 形状与 `kind=local; echo $kind` 由 deny 变 allow；`for f in a /etc/passwd; do cat $f; done` 仍 deny **且理由匹配 `/unsafe for loop value/`**（不是 `unset environment variable`）、`X=/etc/passwd; cat $X` 的理由匹配 `/unsafe assigned value/`（两条**不与环境变量共用理由串**）；`cat $MINI_DSH_UNSET_VAR/file` 与 `read x; echo $x` 仍 deny；`for f in $(ls); do echo hi; done` 判定与今日逐字相同；**反例**：删 `for` 分支后 loop 用例变红，`isSafeBindingWord` 恒真后**理由断言**变红（命令仍 deny，只是理由变成 `system path is blocked`） | 1 次 |
| NX-24-5 | 被引号成词的正文以 `/` 开头（族④）（**done**） | 三条 awk／sed 用例由 deny 变 allow，`cat "/Program Files/secret"` 作为**接受的连带**写成 allow 行；`ls /`、`ls //etc`、`cat //home/user/.ssh/id_rsa`、`cat //server/share/secret`、`node -e "//comment"`、`cat /etc/passwd` 仍 deny；`node -e "// comment"`、`grep -n "//" src/index.ts` 仍 allow；**反例**：还原 `/^\/{2,}/` 后 awk 用例变红 | 1 次 |
| NX-24-6 | 契约、矩阵、回放探针与回填（**done**） | 矩阵两条 `known gap NX-24` 行**先跑到 `met` 留证**再搬进两个新契约组，重跑 `no contract drift` 且新组全 `ok`；第 83 行改登 `known gap NX-25`、新增 `known gap NX-26` 行；新建 `nx24-replay-probe.mjs`，退出码 0 且**逐条给出 9 条残留的归属**（不写未验证的断言）；R-20／CHANGES／README／PROGRESS 回填；`pnpm check` 90 文件、`pnpm test` 212/212、`pnpm fixtures:check` 16 项、`pnpm eval:offline` 12/12、三条 `pnpm demo:*` 退出 0 | 1 次 |

**结果（2026-10-01，零付费）**：回放 782 次真实模型 bash 调用，**拒绝由 32 条降到 9 条**（4.1% → 1.15%）。9 条逐条有归属：**2 条是真阳性**（双引号内未转义、未在本串绑定的 `$ad`／`$c`，bash 确实会展开成空串；本次**刻意保留**）、**4 条 NX-27**（`> /tmp/…`，Git Bash 的 `/tmp` 与 `node:path` 不一致）、**1 条 NX-28**（here-doc 正文里的盘符形状）、**1 条 NX-18**（`cat ../package.json` 的 `..` 整串正则）、**1 条 NX-29**（正则字面量 `/missing` 与绝对根路径同形，无形状判据可用）。`nx24-replay-probe.mjs` 对这 9 条做**集合断言**（不是计数断言），任何一次改动让这 782 次调用中的某一条翻面都会红。

**提交**：`fcd06e7`（NX-24-0）、`27f27aa`（NX-24-1）、`84d9555`（NX-24-2）、`a9708c1`（NX-24-3）、`a173952`（NX-24-4）、`f8f642c`（NX-24-5），以及本提交（NX-24-6 回填）。详细证据见 [CHANGES 的 NX-24 节](CHANGES.md#nx-24-闸门词法偏差的误拒收口)。

### NX-26 保留字之后的命令段起点

**方向是收紧**：`executable` 判据（`src/core/sandbox-runtime.ts:439`）只认「首 token」与「紧邻 `|`／`;`／`&`／换行」，而它是**命令段起点**的定义——为真时重置每段状态并开启取网工具的操作数模型（`:466` 的 `model && !executable` 守卫）。于是保留字后面的命令词永远不是段起点，**`for f in a; do curl example.com; done` 今日就是 allow**。这是一条**独立于 NX-24 的既有放行**（矩阵的 `known gap NX-26` 行），但 NX-24 绑定 `for` 变量后会有更多命令走到这条路径。修法与取舍见 [PLAN 的 D-14](PLAN.md#d-14-命令段起点的词法判定)。

**爆炸半径是实测的**：用闸门自己的分词正则把 `.eval-evidence/` 里 782 次真实模型 bash 调用重放，关键字处在命令位的共 24 处，后随 token 全是 `echo`／`printf`／`node`／`od`——**零个是取网工具**，即语料上不新增拒绝。

| 子步骤 | 内容 | 验收 | 提交边界 |
| --- | --- | --- | --- |
| NX-26-0 | 立项与契约订正（**done**；四行的编目与状态在本提交一次性写下，随后每步各自提交） | `grep -cE '^\| NX-26-' docs/context-budget/TASKS.md` = 4；每行「验收」列至少含一个反引号命令或可判定的 `grep`/退出码判据；PLAN 新增 `D-14` 且 D-13 尾句改成「2026-10-01 由 D-14 闭合」（痕迹不删）；R-20 标题加 `NX-26`、新增段落、验收追加 NX-26 行、边界句把 NX-26 换成 NX-30 登记；NX-30 在 TASKS 出现；矩阵此刻仍读 `open`（**留证**）；`git diff --stat` 只含 `docs/context-budget/` 四份文件 | 1 次 |
| NX-26-1 | 机制 ＋ `do`／`then`／`else`（**done**） | 四处改动：模块级 `commandIntroducers`、循环状态 `pendingCommandPosition`、`:439` 改两行、`:448` 后插一行；`for f in a; do curl example.com; done` 等由 allow 变 deny（理由 `/unauthorized outbound request/`）；`echo do curl example.com`、`printf do curl example.com`、`"do" curl example.com`、`./do curl example.com` 仍 allow；矩阵 NX-26 行读到 **`met`** 并留证；**反例三条**：删旗标赋值行→deny 行变 allow，把赋值行挪出 `if (executable)` 块→`echo do …` 变 deny，`raw === token` 换成 `basename`→`./do …` 变 deny | 1 次 |
| NX-26-2 | 扩到条件引导词 `if`／`elif`／`while`／`until`（**done**） | 集合加四个词后 `if curl example.com; then echo ok; fi`、`while curl …; do …; done`、`until …`、`elif …` 由 allow 变 deny；`if true; then echo a; else curl …; fi` 由 allow 变 deny；两条净放宽（`do echo <url>`、`do echo bash -c "curl …"`）与 `locked` 实例的 allowHosts 双向用例落地；**反例**：对集合那一行重跑反例 1；矩阵其余行不动 | 1 次 |
| NX-26-3 | 矩阵搬移、NX-30 登记与回填（**done**） | 矩阵 NX-26 行**先跑到 `met` 留证**再搬进新契约组 `closed: NX-26 reserved-word command position`，重跑 `no contract drift` 且新组全 `ok`；新增 `known gap NX-30` 组（`(curl example.com)`、`{ curl example.com; }`）；头部注释订正；`node docs/context-budget/nx24-replay-probe.mjs` 退出码 0 且**仍是那 9 条集合断言**；CHANGES／REQUIREMENTS／PLAN／PROGRESS 回填，README 的 207 → 214（NX-24 遗留漂移，顺带订正）；`pnpm check` 90 文件、`pnpm test` 214/214、`pnpm fixtures:check` 16 项、`pnpm eval:offline` 12/12、三条 `pnpm demo:*` 退出 0 | 1 次 |

**提交**：`784eb4a`（NX-26-0）、`4e7afd2`（NX-26-1）、`5c96ce0`（NX-26-2），以及本提交（NX-26-3 回填）。详细证据见 [CHANGES 的 NX-26 节](CHANGES.md#nx-26-保留字之后的命令段起点)。

### NX-30 子 shell 与分组的命令段起点

**方向是收紧**，与 NX-26 同族：`executable`（`src/core/sandbox-runtime.ts:446`）是**命令段起点**的定义（为真时重置每段状态、并开启取网工具的操作数模型，`:481` 的 `model && !executable` 守卫）。**引入命令位置的另一半不是保留字，是算子**——子 shell `( … )` 与分组 `{ …; }`。它们此前连算子都不算：词体类 `[^\s|;&<>]+`（`:432`）把括符粘进 token，于是 `networkTools[basename]` 与 `shellWords.has(basename)` 双双落空，**`(curl example.com)`、`{ curl example.com; }`、`(bash -c 'curl http://x')` 今日全是 allow**（矩阵的两行 `known gap NX-30`）。修法与取舍见 [PLAN 的 D-15](PLAN.md#d-15-命令段起点的算子支)。

**核心取舍是「规范 token，不动分词器」**，因为最自然的方案实测是错的：把四个字符从词体类里拿掉**不会产出 token、只是静默跳过**（`matchAll` 没有以它们开头的分支），于是「opener token」是死代码且 `( curl x )` 仍修不好；同一次改动还会**凭空造出裸 `/` 开头的 token**（`mkdir -p src/{a,b}/x` 被切成 `src/`、`a,b`、`/x`，最后那个是根路径操作数 → `path escapes the workspace`）；改用把 `(` 加进分隔符类则让 `$()` 内的 `commandWord` 被重置，`echo $(date) https://example.com` 由 allow 变 deny。分词器的下标对齐是 `pipedDownstream`（`:459`）、`eval` 参数切片（`:538-542`）、`-c` 片段抽取三处的承重墙，故改为在去引号后剥离 token 首尾未被引用的括符，并把 `(`／`{` 接进与保留字**同一支**的 `pendingCommandPosition` 前视。

**执行方式**：用户从四个单调递增的档位里选定**最窄一档**——只做算子。赋值／重定向／`exec` 前缀、包装命令（`env`／`nice`／`timeout`／`xargs`／`find -exec`）、`case … in a)` 臂体**都不做**，后两者分别留在本节的剩余半与新登记的 NX-31。

**爆炸半径是实测的**：把 `.eval-evidence/` 里 782 次真实模型 bash 调用（去重后 624 条命令）按闸门自己的分词与分隔符正则重放，「真正由算子引入命令位」**2 处**——一个 `(git status --porcelain || echo no-git)`、一个 `{ echo "FAIL(exit=$?)"; … }`，**0 处取网**；`exec`、真实赋值、前导重定向、真 `case` 均为 0 处。

| 子步骤 | 内容 | 验收 | 提交边界 |
| --- | --- | --- | --- |
| NX-30-0 | 立项与契约订正（**done**；三行的编目与状态在本提交一次性写下，随后每步各自提交） | `grep -cE '^\| NX-30-' docs/context-budget/TASKS.md` = 3；每行「验收」列至少含一个反引号命令或可判定的 `grep`／退出码判据；PLAN 新增 `D-15` 且 D-14 尾句改成「2026-10-01 由 D-15 补齐其中的算子支」（痕迹不删）；R-20 标题加 `NX-30`、新增段落、验收追加 NX-30 行、边界句把「子 shell 与分组」换成 NX-31 登记并补三条过拒；NX-31 在 TASKS 出现；矩阵此刻仍读 `open`（**留证**）；`git diff --stat` 只含 `docs/context-budget/` 四份文件；`pnpm test` 215/215 不变 | 1 次 |
| NX-30-1 | 机制 ＋ 测试组（**done**） | 三处改动：模块级 `commandPositionOpeners`、`:444` 的 `const token` → `let token` ＋ 首尾规范化（含 `$(` 的词跳过、空结果保留原样）、`:463` 旗标另半支并入保留字那一行；`(curl example.com)`、`( curl example.com )`、`{ curl example.com; }`、`(bash -c 'curl http://x')` 由 allow 变 deny（理由 `/unauthorized outbound request/`，`-c` 那条为 `in shell -c argument: …`）；四条净放宽（`(echo https://example.com)`、`{ echo https://example.com; }`、`(printf "%s" https://example.com)`、`(echo bash -c "curl https://evil/x")`）连同顶层对照落地，且 `(echo https://example.com \| cat)` 仍 deny；`echo $(date) https://example.com`、`mkdir -p src/{a,b}/x`、`cd $(dirname $0)/src`、`awk '{print $1}'`、`case a in a) echo hi;; esac` 仍 allow；矩阵 NX-30 两行读到 **`met`** 并留证；**反例四条**：删 opener 旗标行→`( curl … )`、`{ curl …; }` 变 allow 且 `{ echo https://…; }` 变 deny；只留首部规范化→6 行变 allow；整个规范化去掉→12 行翻转；集合缩成 `['(']`→分组那一对翻转 | 1 次 |
| NX-30-2 | 矩阵搬移、剩余半与 NX-31 登记、回填（**done**） | 矩阵 NX-30 两行**先跑到 `met` 留证**再搬进新契约组 `closed: NX-30 subshell and group command position`（16 行全 `ok`），重跑 `no contract drift; 8 known gap(s) still open`；新增 `known gap NX-30 arm body`（`case a in a) curl example.com;; esac`）与 `known gap NX-31` 两行（`timeout 5 curl example.com`、`env curl example.com`）；头部注释订正（gap 分「多拦」与「欠拦」两个方向）；`node docs/context-budget/nx24-replay-probe.mjs` 退出码 0 且**仍是那 9 条集合断言**；CHANGES／REQUIREMENTS／PLAN／PROGRESS 回填，README 与 PROGRESS 的 215 → 216；`pnpm check` 90 文件、`pnpm test` 216/216、`pnpm fixtures:check` 16 项、`pnpm eval:offline` 12/12、三条 `pnpm demo:*` 退出 0 | 1 次 |

**提交**：`7ae54f3`（NX-30-0）、`eaac0d5`（NX-30-1），以及本提交（NX-30-2 回填）。详细证据见 [CHANGES 的 NX-30 节](CHANGES.md#nx-30-子-shell-与分组的命令段起点)。**该机制随后由 NX-32 整体撤回**，NX-30 重开为已知缺口（矩阵 `known gap NX-30 reopened`）。

### NX-32 命令闸门的有意收缩与取消窗口

**方向与前面几项相反：不是补边界，是撤回判据。** 取舍与代价见 [PLAN 的 D-16](PLAN.md#d-16-命令闸门的有意收缩nx-32)，现行契约见 [R-20](REQUIREMENTS.md#r-20-命令策略闸门nx-17nx-19nx-24nx-25nx-26nx-30nx-32)。立项依据：`docs/INTERNSHIP_ROADMAP.md` 的 NX 编号全集只到 NX-16——整条闸门收紧线**不在路线图内**，而路线图写明「M5～M7 加最小 M9 演示即可形成投递版本」；`sandbox-runtime.ts` 此时已长成 `src/` 里最大的单文件（576 行，占全部源码 14.6%），且它**在唯一没有审批兜底的 `autoApprove`（评测跑用的就是它，`test/coding-fixtures.test.ts:62,377`）里也拦不住**——`node -e` 程序字符串本就不在覆盖内，实测里模型自写 `node -e` 探针 75 次。

| 子步骤 | 内容 | 验收 | 提交边界 |
| --- | --- | --- | --- |
| NX-32-1 | 闸门收缩（**done**） | `sandbox-runtime.ts` 576 → 120 行；`contracts.ts` 删 `SandboxConfig.allowHosts`；矩阵由 103 行重写为 71 行并读到 `no contract drift; 32 known gap(s) still open`（NX-23 两行**先读到 `met` 再搬进契约组**）；回放探针退出 0（782 次真实调用 7 条拒绝全部有归属，收缩前 9 条），两条 `$ad`／`$c` 真阳性条目按探针自己的规则**删除**而不是放宽断言；`pnpm test` 216 → **204/204**；`pnpm eval:estimate` 退出 0（语料 digest 未动，已实测确认 `corpusDigest` 只读语料文本、从不与 `src/` 比对）；**反例四条**，每条实测到红：去掉段首守卫→`cp foo /usr/bin/evil` 变 allow、段首判定改成看全部前文→`echo "x\|y" /usr/bin/ls` 变 allow、出网提前到路径检查之前→`wget -O /etc/passwd http://localhost/x` 的理由由 system path 变出网、出网赋值挪到段首白名单之后→`/usr/bin/curl example.com` 变 allow | 1 次 |
| NX-32-2 | 取消窗口（**done**） | `kill()` 改为返回永不 reject 的 `Promise<void>` ＋ 2 秒 deadline，`stop()` 记 `terminating`，`close` 在其存在时多等一步；`pnpm test` 204/204；**实测记录**：`durationMs` 新 418ms／老 457ms、返回时孙进程存活各 5/5 都已消失——**观测不到差别**，故**不加**「durationMs 不得短于一次 taskkill 往返」那条断言（它声称能区分实现却两边都过） | 1 次 |
| NX-32-3 | 文档回填（**done**） | R-20 重写为收缩后正文、被删机制降级为「既往」；D-12…D-15 各加一行「由 D-16 有意收缩覆盖」且历史正文保留；新增 D-16；README 门禁段重写与计数 216 → 204；TASKS／CHANGES／PROGRESS 回填；`AGENTS.md` 与 `DECISIONS.md` 不动（前者只说保留路径闸门与审批，仍真；后者无 `sandbox-runtime` 锚点） | 1 次 |

**提交**：`891b11b`（NX-32-1）、`8418c4d`（NX-32-2），以及本提交（NX-32-3 回填）。详细证据见 [CHANGES 的 NX-32 节](CHANGES.md#nx-32-命令闸门的有意收缩与取消窗口)。

### NX-20 路线图状态段的带日期修订注记

**todo（NX-09 期间发现）。零付费、只改一个文档。** `docs/INTERNSHIP_ROADMAP.md` 的状态段整体陈旧：它的 §5 按 2026-09-29 的时点写「其余功能均为 todo」，§6 的简历表述还停在「完成 57 条回归」，而这一线此后已走完（M5／M6／M7／M9 全部收尾，见本文件各节）。

**该文件自己的约束决定处置方式。** 它开头那条「修复更新（2026-09-29）」已把源码基线评估定为「作为历史证据保留」，紧接的「路线修订：2026-09-29」也写明「保留此前源码评估」。因此**不能逐处改写正文**——那样会让同一份文件里「带日期的历史证据」与「当前状态」混成一片。处置按该文件既有惯例：**在页首追加一条带日期的修订注记**，正文一字不动。（正文位置一律引标题与引文，不引行号：注记本身插在页首，引用行号会在插入后立刻漂移。）

**立项前核实（2026-10-02，逐行核对后归纳为四类）**：

1. **§5 完成标记过期**：NX-04／NX-07／NX-08／NX-09／NX-10／NX-11 的条目均无 done 标记，line 185 的「以下其余功能均为 todo」不再成立。
2. **数字订正**：回归数 57 → **205**（line 23、194、235）、产物数 46 → **91**（line 28）、真实模型付费额度 $0 → 约 **$6.44**（line 215，出处 `NX-08-REPORT.md:14`）。
3. **术语订正**：line 235 的「Windows/Linux × Node 22/24」中「Linux」不是仓库实际用词，CI 为 **Ubuntu/Windows**（`README.md:154`，该文件自己的 line 202 亦如此写）。
4. **§4 的将来时已落地**：line 22／24／111（大结果回读＝NX-07）、128（变更清单与 diff＝NX-13）、136（结构化命令结果＝NX-14）、138（verification 证据＝NX-15）、146（3 个与 12 个 fixture＝NX-05a／b）、148（`context/projection` 的 `requestId`＝NX-08a）——这些是**设计方向段落**，落地后仍读作计划。

**明确不改**：line 3 首句、5、9–11、19–21、126（自带日期注记）、189–191、198–199、201–203、211–212、219–221、253–255 —— 均为带日期的历史证据或截至其日期成立。

**不改 `src/`**，不动 fixture，不调用付费模型。

| 子步骤 | 内容 | 验收 | 提交边界 |
| --- | --- | --- | --- |
| NX-20-0 | TASKS 立项：NX-20 子步骤表（**done**） | `grep -cE '^\| NX-20-' docs/context-budget/TASKS.md` = 3；每行「验收」列至少含一个反引号命令或可判定的 `grep` 判据；`git diff --stat` 只含 `docs/context-budget/TASKS.md` | 1 次 |
| NX-20-1 | 页首追加 2026-10-02 修订注记（**done**） | 注记覆盖上述四类且**逐条可核对**：新增行只出现在页首注记区（用 `git diff` 确认正文行逐字未动）；三类数字与 `pnpm check` 实测（90 文件）、`PROGRESS.md:7`（204）、`NX-08-REPORT.md:14`（约 $6.44）一致；`git diff --stat` 只含 `docs/INTERNSHIP_ROADMAP.md` | 1 次 |
| NX-20-2 | TASKS/CHANGES/PROGRESS 回填 | 各行置 `done` 并记提交号；CHANGES 增 NX-20 节且命令与实际输出一致；PROGRESS 的「阻塞」段删去该条陈旧待办 | 1 次 |

**提交**：`ecf5249`（NX-20-0 立项）、`f3a04d2`（NX-20-1 注记），以及本提交（NX-20-2 回填）。详细证据见 [CHANGES 的 NX-20 节](CHANGES.md#nx-20-路线图状态段的带日期修订注记)。

### NX-22 文档内锚点的逐个校验与口径订正

**已完成（2026-10-02，零付费）**（NX-11 期间发现）。NX-11 把「相对链接与锚点目标逐个命中」做成可核对的检查时，只覆盖了 `DECISIONS.md` 一个文件；全仓其余 md 之间的锚点从未被校验过。**立项前核实（2026-10-02）：登记的是「四处」，实际是 6 处**，且其中一类多出一处新失效：

1. **`#其他待办按依赖排序` 共 3 处，不是 2 处**——`TASKS.md` 中 NX-30 与 NX-10 两节里的 `[NX-31]`／`[NX-21]`／`[NX-20]` 三个链接（NX-30 之后新增的那处此前未登记）。目标文本「其他待办，按依赖排序：」在文件中是**正文行**，全文无此标题，因此该锚点根本不存在。
2. **`PROGRESS.md` 两条 NX-08f 链接的 slug 与 `CHANGES.md` 标题对不上**；**且这不只是锚点问题**：同一批里 f-4b 标题写 `$0.02`、紧邻正文写 `$0.03`，PROGRESS 两条写 `$0.03`／`$0.04`，三个数字互相矛盾。
3. **新发现第 5 处**：`TASKS.md` 里 `[PLAN 的对照有效性条件](PLAN.md#nx-08 评测批次上限预注册)` 的锚点含**字面空格**，任何 slug 规则下都不存在；同文件上文已写对为 `#nx-08-评测批次上限预注册`。

**成本口径先固定（本项的第一个交付物，不是顺手改）**：以 **`NX-08-REPORT.md` 的成本表为准**——「两次烟测 … **$0.05**（第一次 139k token 约 **$0.02**、第二次 166k 约 **$0.03**）」，且该文件开头的总额 $6.44 按 $0.05 计入，内部自洽；按价格页 off-peak 输入 $0.15/M 复算 139k ≈ $0.021、166k ≈ $0.025，吻合。故**错的是 CHANGES 的 f-4b 正文与 PROGRESS 的两条数字**，**CHANGES 的两个标题是对的、不改**。

**检查器形态（用户选定）**：新增 `test/docs-links.test.ts` 进 `pnpm test` 与四组合 CI，沿用 NX-11 的 `test/decisions-doc.test.ts` 先例。必须按 **github-slugger v2 语义**：小写 → 去 Unicode 标点/符号 → **逐字面空格各换一个 `-`、不折叠连续空格**（折叠会把 `…--done…` 这类正确的双连字符误报）。

| 子步骤 | 内容 | 验收 | 提交边界 |
| --- | --- | --- | --- |
| NX-22-0 | TASKS 立项：子步骤表，并把「四处」订正为 6 处（**done**） | `grep -cE '^\| NX-22-' docs/context-budget/TASKS.md` = 5；每行「验收」列至少含一个反引号命令或 `grep` 判据；`git diff --stat` 只含 `docs/context-budget/TASKS.md` | 1 次 |
| NX-22-1 | 新增 `test/docs-links.test.ts` 并取**修前红**证据（**done**） | 测试按 github-slugger 语义逐个校验全仓相对 md 锚点；实跑结果**恰好 6 条失败**、其余去重锚点对（约 90 对）全部通过——**这同时证明无假阳性**；命令与逐条失败输出记入 CHANGES | 1 次 |
| NX-22-2 | 修 6 处锚点与三处成本数字（**done**） | `pnpm test` 全绿（205/205）；**反例实跑**：把任一条已修好的锚点改坏后 `pnpm test` 必须红、改回必须绿（命令与输出记入 CHANGES）；`grep -c '付费约 \$0\.04' PROGRESS.md` = 0，且 PROGRESS 两条的数字与 CHANGES 的 f-4b／f-4c 两个标题**逐字一致**（注意修好后 `$0.03` 仍会出现一次，判据不能写成「不含 `$0.03`」）；CHANGES 的 f-4b **正文**与标题数字一致 | 1 次 |
| NX-22-3 | 订正 `NX-08-REPORT.md` 的 fixture 计数（**done**） | 该行 `fixtures:check` 读数与 `pnpm fixtures:check` 实测（16 项、初始 0/16、参考 16/16）一致；`git diff --stat` 只含 `docs/context-budget/NX-08-REPORT.md` | 1 次 |
| NX-22-4 | TASKS/CHANGES/PROGRESS 回填与计数同步（**done**） | 各行置 `done` 并记提交号；CHANGES 增 NX-22 节且命令与实际输出一致；`pnpm test` 新增 1 条使用例数 204 → 205，README／PROGRESS／`test/fixtures/coding/README.md` 的计数与实跑一致 | 1 次 |

**提交**：`4c7946c`（NX-22-0 立项）、`5e170b7`（NX-22-1 测试与修前红）、`0d11876`（NX-22-2 修 6 处锚点与三处成本）、`e3ae322`（NX-22-3 报告计数），以及本提交（NX-22-4 回填）。详细证据见 [CHANGES 的 NX-22 节](CHANGES.md#nx-22-文档内锚点的逐个校验与口径订正)。

### NX-21 会话锁的陈旧核验入口与显式移除

**已完成（2026-10-02，零付费）**（NX-10-5 期间发现）。`JsonlStore.open` 对任何已存在的 `writer.lock` 一律拒绝（`src/core/event-store.ts` 的 `open`），提示语要求「verify stale locks explicitly」，而仓库里**没有任何可脚本化的核验入口**，于是崩溃之后唯一的恢复路径是由人手删文件。本项把这一步换成一条**只把证据摆出来、解除与否由操作者显式决定**的入口。

**立项前核实（2026-10-02）**：

1. **进程内子命令在真正需要它的时刻不可达**——`src/plugins/cli.ts:38` 在 `ctx.effect` 建立 REPL **之前**就 `await JsonlStore.open(...)`，撞上崩溃过的会话直接抛错，`/recover`／`/lock` 这类斜杠命令根本轮不到被输入。这一条决定了入口的形态：**独立脚本，不是斜杠命令**。
2. **`quarantineTail` 不是替代路径**：它也要先抢同一把锁（同一个 `writer.lock`），只能在**锁已被移除之后**才谈得上。
3. **锁体里写了 `pid`，但此前从不被读回**。本机实测（win32，Node 24）：`process.kill(存活 pid, 0)` 成功、对**已退出**的子进程抛 `ESRCH`——但 `process.kill(0, 0)` **同样成功**，pid 0 会被误报成「存活」。跨平台差异与 pid 复用因此要求这条探针只能是**线索**：读数只给人看，不参与任何判断。
4. **规范性依据已存在**：`PLAN.md` 的持久化一节写有「失效锁显式核验，**不仅凭 PID 自动移除**」。本项**不新增决策编号**——它实现这条既有决策，不是新决策。

**设计边界（写死，实施期不改）**：

- **PID 只作证据，不作判据**：探针结论是三态 `alive`／`not-found`／`inconclusive`，`pid` 非正整数或 `pid ≤ 0` 一律 `inconclusive`；输出必须写明「pid 复用下 `alive` 不等价于持有者还在」。
- **移除必须由操作者显式表达**：`--remove` **且** `--token <检视输出里的那个 token>`。token 比较是竞态守卫，与 `close()` 的 `writer lock ownership changed` 同一套语义——它挡住的正是「原持有者已死、新写入者刚拿到锁」这个窗口。
- **范围（用户选定「最小可用」）**：单会话检视 + 显式移除。**不做**无参列表、**不做** `--quarantine`（只在检视里**报告**尾部是否完整，供操作者决定下一步）。
- **不改 `open`／`close`／`quarantineTail` 的任何一行**——既有的拒绝语义逐字不动。

**带日期的历史证据逐字不动**（与 NX-20 同一条规则）：`TASKS.md` 的 NX-10 一节里「恢复的唯一路径是先由人删掉该锁」、`CHANGES.md` 的 NX-10-5／NX-10-6 两节、`PROGRESS.md:25`（`[NX-21](#阻塞)` 与「本次只立项不修」）。那条限制在写下时**为真**，本项不是「补上漏改」。

**两处只有真跑才会暴露的坑（已修，留在源码注释里）**：① `--token` 的取值既不是旗标也不是位置参数——用「过滤掉 `--` 开头的」挑参数会把它算成**第二个 sessionId**，四个状态里两个直接报用法错；改成按「谁消费了谁」逐个走才对。② 演示里判定「锁已移除」**不能到判定那一刻再查文件**：下一幕重开会装上一把**新锁**，`exists(lockPath)` 必然为真，必须就地取值。这两处都不是设计问题，是写的时候想不到、跑一次就露的。

**另一处连带修正**：本次向 `event-store.ts` 插入 45 行使 `DECISIONS.md` 钉住的 `src/core/event-store.ts:52`（`append`）漂到 `:97`，由 `test/decisions-doc.test.ts` 当场抓出并随 NX-21-2 订正——这正是那套锚点回归存在的理由。本节也因此**不再引行号**，一律引符号名。

| 子步骤 | 内容 | 验收 | 提交边界 |
| --- | --- | --- | --- |
| NX-21-0 | TASKS 立项：本节的设计边界与子步骤表（**done**，`4fb4e7c`） | `grep -cE '^\| NX-21-' docs/context-budget/TASKS.md` = 5；每行「验收」列至少含一个反引号命令或可判定的退出码／`grep` 判据；`git diff --stat` 只含 `docs/context-budget/TASKS.md` | 1 次 |
| NX-21-1 | 核心 `JsonlStore.inspectLock`／`removeStaleLock` 与入口脚本 `scripts/session-lock.ts`（含 `pnpm session:lock`）（**done**，`90b7733`） | `pnpm check` → `syntax ok: 92 files`；临时 `MINI_DSH_SESSION_DIR` 上造「无锁」「陈旧锁 `{token:'t',pid:1}`」两态，`node dist/scripts/session-lock.js <id>` 均退出 0 并打印 pid 探针与可复制的下一步命令；`--remove` 缺 `--token`、token 不符、`--token` 无 `--remove` 三种用法错误均退出 1 | 1 次 |
| NX-21-2 | `test/session-lock.test.ts`（**done**，`2d35d28`） | `pnpm test` → `fail 0`，用例数 **205 → 211**；**反例实跑**：把 `removeStaleLock` 的 token 比较改成恒真后 `pnpm test` 变 `fail 2`（核心用例与 CLI 冒烟各一条）并点名，改回 `pass 211 / fail 0`（命令与输出记入 CHANGES）；用例覆盖 `pidStatus` 三态与 `eventsTail` 两态、错 token 被拒后锁仍在、正 token 移除后 `JsonlStore.open` 成功且 `restore` 补出恰好一条 `unknown` | 1 次 |
| NX-21-3 | 第三幕改用新入口（含错 token 被拒的反例）（**done**，`4551e62`） | `pnpm demo:unknown` 退出 0，判定 9 条全 ✓（含 pid 探针、`✓ 错误 token 被拒、锁仍在`、`✓ 正确 token 显式移除`），且**不再**出现「没有可脚本化的核验入口」 | 1 次 |
| NX-21-4 | 口径订正、计数同步与三份清单回填（**done**） | 各行置 `done` 并记提交号；README／PROGRESS／DECISIONS／PLAN 四处口径与实现一致，且 `README.md` 的「不会仅凭PID自动解除」逐字保留；`sed -n '54,64p' README.md \| grep -c '^pnpm '` = 8（新命令不进零密钥八条）；`pnpm check` 93 文件／`pnpm test` 211 与实跑逐字一致；`pnpm eval:estimate` 仍退出 0（未碰 estimation corpus） | 1 次 |

**提交**：`4fb4e7c`（NX-21-0 立项）、`90b7733`（NX-21-1 核心与脚本）、`2d35d28`（NX-21-2 测试与 DECISIONS 锚点）、`4551e62`（NX-21-3 第三幕），以及本提交（NX-21-4 回填）。详细证据见 [CHANGES 的 NX-21 节](CHANGES.md#nx-21-会话锁的陈旧核验入口与显式移除)。

### T6 Biome 的收窄配置与处置

**诊断（2026-10-02，草稿副本内只读，仓库一行未动）**。`npx biome check .` 给出 **545 errors / 124 warnings / 48 infos = 717**。仓库里**没有 `biome.json`**，因此没有任何排除项：其中 **196 条落在 `dist/`、14 条落在 `.eval-evidence/`**（两者都在 `.gitignore` 里），余下 **507 条（366 err / 117 warn / 24 info）分布在 250 个文件**，而**每一个文件**都至少有一条 `format` 诊断。这不是 250 个文件各有风格问题，是**一次全局配置分歧**：Biome 默认制表符／双引号／分号，仓库是 2 空格／单引号／无分号。

**长行靠配置救不了**：Biome 2.5.14 拒绝 `lineWidth > 320`，而仓库有 **17 行超过 320**（最长 732，`src/core/event-validation.ts`）、131 行超 200、1219 行超 120。所以「修到绿」必然要重排约 2000 行。

**修绿成本实测（草稿副本，两种修法各跑一遍）**：

| 修法 | 触及文件 | 行数 | 剩余 | `pnpm check` | `pnpm test` |
| --- | --- | --- | --- | --- | --- |
| 安全 `--write` | 210 | −4928 / +7491 | 160 err | ✅ `93 files` | ❌ **fail 2** |
| `--write --unsafe` | 211 | −4961 / +7523 | 12 err | ❌ **8 条 TS 错误** | ❌ 构建先失败 |

**两条路都会打破仓库自己的回归套件，因为那里钉着机器不变量**：① `test/estimation.test.ts` 给 `src/core/token-estimator.ts` 钉了 SHA-256，重排即改字节，报错原文要求「re-run the NX-08c measurement and update the recorded conclusions and 核验日期」——**重排该文件等于作废一次实测结论**；② `test/decisions-doc.test.ts` 的三十行锚点随 `organizeImports` 位移而漂移（与 NX-21 咬过的那次同因）；③ unsafe 修法删掉 `!` 之后产生 8 处 `TS2532`／`TS2345`。

**用户选定方向（2026-10-02）：收窄配置，不设门禁**——不重排既有代码，只把 Biome 调成与仓库风格不冲突，并把它真正能抓到的 21 条发现逐条修掉。

**设计边界（写死，实施期不改）**：

- **关掉 formatter 与 organizeImports，而不是「暂时忽略」**：这两项的判定在本仓库**不可满足**——`lineWidth` 上限 320 小于仓库最长行 732，而 `organizeImports` 一开就位移行号、直接打破 `DECISIONS.md` 锚点。这不是偷懒，是它们与既有不变量无法共存。
- **`test/fixtures/**` 整体排除**：那里是**故意写坏的初始态**（`retry/initial/src/retry.mjs` 的未用参数就是待修缺陷），`pnpm fixtures:check` 的 16 项契约依赖它们保持坏。Biome 不得「修好」它们。
- **只关掉与仓库刻意风格正面冲突的规则**：`noNonNullAssertion`（107 处；且 unsafe 修法会删 `!` 破坏类型）、`useTemplate`（46 处，刻意拼接）、`noControlCharactersInRegex`（ANSI 剥离，见 `src/plugins/cli.ts` 的 `\x1b` 正则）。**其余真实发现逐条修，不用关规则绕过。**
- **`format` 脚本一并移除**：formatter 关掉之后 `biome format --write .` 是**静默空转**，留着比没有更糟。
- **不加 CI 步骤、不加测试**（用户选定）。**代价必须写明**：没有门禁就会漂移，这一条同时记进 `AGENTS.md:21` 与 CHANGES，不靠读者自觉。
- **不碰 `src/core/token-estimator.ts` 的任何一个字节**：它的哈希是 `test/estimation.test.ts` 的锚。上面的配置选择恰好使该文件**零诊断**（它只有 `noNonNullAssertion`／`organizeImports`／`format` 三类，全在关掉的范围内）——这是本方向能成立、而「修到绿」不能的**关键**。

| 子步骤 | 内容 | 验收 | 提交边界 |
| --- | --- | --- | --- |
| T6-0 | TASKS 立项：本节（**done**，`c01f253`） | `grep -cE '^\| T6-' docs/context-budget/TASKS.md` = 3；每行「验收」列至少含一个反引号命令或可判定的退出码／`grep` 判据；`git diff --stat` 只含 `docs/context-budget/TASKS.md` | 1 次 |
| T6-1 | `biome.jsonc` + `package.json`（移除 `format`）+ `AGENTS.md:21` + 9 个源码文件的逐条订正（**done**，`b46dd79`） | `pnpm lint` **0 诊断、退出 0**（修前 717 诊断含 545 错）；`pnpm check` → `syntax ok: 93 files`；`pnpm test` → `pass 211 / fail 0`（含 `decisions-doc` 与 `estimation` 两条不变量按名通过）；`git diff --stat` **不含** `src/core/token-estimator.ts`；**反例实跑**：把 `formatter.enabled` 与 `assist.organizeImports` 打开后 `biome check` 报 175 errors、`--write` 动 100 文件、`pnpm test` 变 `fail 2` 并点名那两条不变量，改回必须全绿（命令与输出记入 CHANGES） | 1 次 |
| T6-2 | 口径订正与三份清单回填（**done**） | `grep -rn '尚未通过 Biome' README.md` 为空；`grep -cE '^\*\*提交\*\*：待本项收尾时回填。$' docs/context-budget/TASKS.md` = 0（顺手删掉 NX-21 立项时遗留的占位提交行）；`sed -n '54,64p' README.md \| grep -c '^pnpm '` 仍 = 8（`lint` 不进零密钥八条）；`pnpm check`／`pnpm test` 的计数与实跑逐字一致；`pnpm eval:estimate` 仍退出 0；T6 在 TASKS 标 `done（2026-10-02，零付费）` 并链到本节 | 1 次 |

**配置落在 `biome.jsonc` 而非 `biome.json`**：2.5.14 的 `biome.json` 不接受 `//` 注释。更值得记的是**配置解析失败时 Biome 不报错，直接退回默认规则**——用 `.json` 写带注释的版本时 `pnpm lint` 会照常输出一整套默认规则的诊断，看上去像「配置生效了但代码不合规」。第一次跑就落进这个坑，靠「诊断条数与修前逐字相同」才发现。改用 `.jsonc` 既拿到注释（每条排除项就地带理由），也避开了静默失效。

**提交**：`c01f253`（T6-0 立项）、`b46dd79`（T6-1 配置与源码订正），以及本提交（T6-2 回填）。详细证据见 [CHANGES 的 T6 节](CHANGES.md#t6-biome-的收窄配置与处置)。

### NX-18 目录逃逸的 token 级判定

**问题（NX-17 期间发现；2026-10-02 按 D-16 的处置规则重开）**。`..` 是闸门保留的四条整串正则之一。整串正则的好处是廉价且稳定，代价是它**不区分「数据」与「代码」**：`echo "see ../docs for details"`、`grep -n ".." src/index.ts`、`git log --grep "../ fixes"` 三条全部被判 `.. path escape is blocked`——第一条里的 `../` 在双引号内是散文，后两条里的 `..` 是正则。它同时是用户「放宽不得削弱 `..`」条款点名保护的对象，所以 NX-17／NX-19／NX-24／NX-32 四轮都刻意没动它。

**先把这条例外的价格算清（`.eval-evidence/` 回放，782 次真实模型 bash 调用，按各会话自己的 workspace 重放）**：含 `..` 的调用 **57 条，其中只有 1 条被拒**（`062d867579`）。**但那一条不是整串正则的错**——命令是 `cd src && … ; cat ../package.json; ls ../data`，闸门**不知道命令内部的 `cd` 改过目录**，`../package.json` 相对 workspace 根确实越界。**因此本轮修完它仍然被拒**，继续留在 `nx24-replay-probe.mjs` 的 `expected` 集合里，只把注记从「`..` 整串正则」改成真实原因（**闸门不看命令内的 `cd`**，属 D-16 撤掉的命令位置状态族）。把它与「清掉回放拒绝」分开写，是因为「登记一条缺口」与「这条缺口会不会被本轮关掉」是两件事。

**新判据：token 级路径形状判定（整串正则退场）**。一个 token 判为 `..` 逃逸，当且仅当它的**去引号正文**同时满足三条：

1. **不含空白**——含空白的 token 不是可寻址的路径。NX-24-5 已用同一条先例处理过前导斜杠（真实的根级目录名不以空白开头），本轮沿用而不是新立。`"see ../docs for details"` 与 `"../ fixes"` 栽在这条。
2. **按 `[\\/=]` 切分后存在一个分量恰为 `..`**——判的是「路径分量」，不是「文本里出现过两个点」。`a..b`、`...`、`a/x../y` 因此都不算。`=` 一并计入分量边界，因为 `--file=../secret` 的取值同样是操作数，不计入就会**顺着这次放宽新开一个洞**。
3. **正文含分隔符，或它在原串里是裸词**——这是本轮**唯一**的放宽：引号成词、且不含分隔符的 `".."`（`grep -n ".."` 的正则）放行，**裸 `..` 照旧拒绝**（`ls ..`、`cd ..` 不动）。放行的只有这一种形状，理由记在 PLAN 的 D-17。

**必须保持被拒（用例逐条钉住）**：`echo ../secret`、`cat ../secret`、`cp ../a b`、`cat $MINI_DSH_TEST_ROOT/../etc/passwd`、`cat "../secret"`（引号成词但含分隔符）、`ls ..`、`cd .. && …`。

**残险与不修的部分（写进 R-20 与 D-17，不用「已闭合」措辞）**：这是一次**有界的放宽**，「用引号包住裸 `..`」的形状（`cd ".." && cat x`）从此放行。判据本身是粗形状检查，真正的边界仍是 `utils/path.ts` 的 `resolveInside` 与人工审批——**两者都不是操作系统隔离**。另外 `--grep=..` 这类「`=` 后紧跟 `..` 且无分隔符」的惰性文本**仍被拒**：它与 `--dir=..` 在形状上无判据可用，按 NX-29 的口径处理——**没有可用的形状判据就不放宽**。

| 子步骤 | 内容 | 验收 | 提交边界 |
| --- | --- | --- | --- |
| NX-18-0 | TASKS 立项：本节（**done**，`8e36afd`） | `grep -cE '^\| NX-18-' docs/context-budget/TASKS.md` = 4；每行「验收」列至少含一个反引号命令或可判定的退出码／`grep` 判据；**`pnpm test` → `pass 211 / fail 0`**（T6-0 的教训：新章里的锚点本身就是一条要跑的验证，本节的链接只指向既有标题）；`git diff --stat` 只含 `docs/context-budget/TASKS.md` | 1 次 |
| NX-18-1 | `src/core/sandbox-runtime.ts`：删掉整串 `..` 正则，改为 token 级判定；同步 `:18` 与 `:78` 两处注释（「四个整串正则」→「三个」）（**done**，`b9ca89f`） | `pnpm check` → `syntax ok: 93 files`；`pnpm test` → `pass 211 / fail 0`（既有 deny 行全部仍绿）；`node docs/context-budget/nx17-gate-probes.mjs` 的 `kept: escape and system paths` 组无 `drift`；**回放**：`node docs/context-budget/nx24-replay-probe.mjs` 退出 0 且拒绝集合**一条不增**（仍 7 条，`062d867579` 在内） | 1 次 |
| NX-18-2 | `test/core.test.ts` 扩表；`nx17-gate-probes.mjs` 把两行搬进契约组；`nx24-replay-probe.mjs` 订正注记（**done**，`dfcfa1c`） | `pnpm test` → `fail 0`；`node docs/context-budget/nx17-gate-probes.mjs` 输出 `no contract drift` 且 `known gap` 由 32 行降到 **29 行**（第三行是 `X=..; cat $X/secret` 的连带收紧，与 NX-18 两条一并搬出）；**反例实跑两条**：还原整串正则 → `fail 1` 点名 `echo "see ../docs for details"`；把分量判定退化成 `body.includes('..')` → `fail 2` 点名 `ls a/x../y`；改回必须 `pass 211 / fail 0`（命令与输出记入 CHANGES） | 1 次 |
| NX-18-3 | 口径订正与三份清单回填（**done**） | R-20 与 `src` 一致（整串正则四条→三条、`..` 并入 token 路径判定、边界句去掉 NX-18）；PLAN 新增 D-17 且 D-16 带日期的局部修订注记在位；CHANGES 增 NX-18 节且命令与实际输出一致；`pnpm check`／`pnpm test`／`pnpm fixtures:check`／`pnpm eval:offline` 的计数与实跑逐字一致；`sed -n '54,64p' README.md \| grep -c '^pnpm '` 仍 = 8；`pnpm eval:estimate` 仍退出 0；NX-18 在 TASKS 标 `done（2026-10-02，零付费）` 并链到本节；**连带订正 NX-21-4 遗留的两处陈旧计数**（`README.md` 分界表的 `205 条`、`PROGRESS.md` 主分支基线的 `91 文件`／`205/205`），用 `git blame` 指明引入提交为 `1081781f` | 1 次 |

**提交**：`8e36afd`（NX-18-0 立项）、`b9ca89f`（NX-18-1 判据替换）、`dfcfa1c`（NX-18-2 契约与矩阵），以及本提交（NX-18-3 回填）。详细证据见 [CHANGES 的 NX-18 节](CHANGES.md#nx-18-目录逃逸的-token-级判定)。

## NX-27 Windows Git Bash 的 `/tmp`

**问题（NX-24 回放实测；2026-10-02 由用户排期）**。Windows 上命令最终交给 Git Bash，Git Bash 把 `/tmp` 映射到用户临时目录；命令闸门却用 Windows `node:path` 直接解析 `/tmp/out.txt`，得到当前盘根下的 `D:\tmp\out.txt`，再按工作区外路径拒绝。782 次真实模型 bash 调用里有 4 条因此被误拒，最小复现是 `echo x > /tmp/out.txt`、`cat /tmp/out.txt` 与 `node tmp.mjs > /tmp/r.log`。

**选定方向：映射挂载点，不按字符串无条件放行。** 仅在 `process.platform === 'win32'` 且 token 归一化后仍位于 POSIX `/tmp` 下时，把 `/tmp` 后的相对部分交给 `resolveInside(os.tmpdir(), relative)`；其他平台与其他根路径维持现状。这样判据与 Git for Windows 的实际挂载语义一致，同时复用既有的词法越界与真实路径／软链检查：`/tmp/../etc` 仍由 `..` 判据拒绝，`/tmp-link` 不冒充临时目录，临时目录里的链接若指向目录外仍报 `through a symlink`。该例外只属于 bash 命令闸门，不扩大文件工具的 workspace 根，也不把 `/tmp` 加进 `SandboxConfig`。

**边界与代价**：Windows 上 bash 命令从此可读写用户临时目录，它不再受“仅工作区”这条粗形状判据限制；写入与执行仍走既有审批，`autoApprove` 评测则按其本来语义不询问。该闸门不是操作系统隔离，映射采用 Node 的 `os.tmpdir()` 作为 Git for Windows `/tmp` 的宿主目录；本项不探测任意 MSYS 挂载表，也不泛化到 `/var/tmp`、盘符以外的其他 POSIX 根。

| 子步骤 | 内容 | 验收 | 提交边界 |
| --- | --- | --- | --- |
| NX-27-0 | TASKS 立项：本节（**done**） | `grep -cE '^\| NX-27-' docs/context-budget/TASKS.md` = 3；每行「验收」列至少含一个反引号命令或可判定的退出码；`pnpm test` 基线仍为 `pass 213 / fail 0`；`git diff --stat` 只含 `docs/context-budget/TASKS.md` | 1 次 |
| NX-27-1 | `sandbox-runtime.ts` 加 Windows Git Bash `/tmp` → `os.tmpdir()` 映射；`core.test.ts` 钉住读、写、边界与软链（**done**） | Windows 上 `echo x > /tmp/nx27.txt`、`cat /tmp/nx27.txt`、`node tmp.mjs > /tmp/nx27.log` 均 allow；`cat /tmp-link/x`、`cat /tmp/../etc/passwd` 与临时目录内指向外部的链接仍 deny；非 Windows 分支不放宽；`pnpm check`、`pnpm test`、`pnpm lint` 全部退出 0；反例把映射短路后至少 3 条 allow 用例变红 | 1 次 |
| NX-27-2 | 同步 R-20／PLAN D-19／矩阵与回放探针，回填 CHANGES、PROGRESS、README 状态（**done**） | `node docs/context-budget/nx17-gate-probes.mjs` 输出 `no contract drift`；`node docs/context-budget/nx24-replay-probe.mjs` 退出 0 且拒绝由 6 条降到 2 条，删除的集合恰为 4 个 NX-27 指纹；`pnpm check`、`pnpm test`、`pnpm lint`、`pnpm fixtures:check`、`pnpm eval:offline`、`pnpm eval:estimate` 全部退出 0；文档不再把 NX-27 列为 todo／已知边界 | 1 次 |

其他待办，按依赖排序：

**另有一条口径变化（2026-10-01，NX-32）：NX-19／NX-24／NX-26／NX-30 由「已完成」退回「已知缺口」。** 它们的机制随收缩一起删除，矩阵里原先的 `closed:` 组整组降级为 `known gap … reopened`（当前共 32 行已知缺口）。与下面的待办不同，**这几条不再排期**——按 D-16 的处置规则，只有 `.eval-evidence` 回放出现新拒绝、或实际使用中撞上才重开。

- **NX-18 `..` 族误判 — done（2026-10-02，零付费）（NX-17 期间发现）**：**本次处置**见 [NX-18 一节](#nx-18-目录逃逸的-token-级判定)。`..` 判据从整串正则改成 **token 级路径形状判定**（去引号正文不含空白、按 `[\\/=]` 切分后存在分量恰为 `..`、且正文含分隔符或它在原串里是裸词），保留的四条整串正则因此变成三条。**先把价格算清**：782 次真实调用里含 `..` 的 57 条**只有 1 条被拒**，而那条（`cd src && … ; cat ../package.json`）的根因是**闸门看不见命令内的 `cd`**、不是整串正则——**本项修完它仍然被拒**，继续留在回放探针的 `expected` 里，只订正注记。**唯一放宽**是引号成词且无分隔符的裸 `".."`（语料里那是正则）；裸 `..`、`"../secret"`、`--file=../secret`、`cp ../a b` 与刻意保留的 `--grep=..` 全部照旧拒绝。矩阵已知缺口 **32 → 29 行**，其中第三行是**连带收紧**：`X=..; cat $X/secret` 由 allow 变 deny，理由是 `..` 而非变量间接，孪生行 `Y=/etc; cat $Y/passwd` 仍是 gap，两条分开记。以下为发现时的原文，保留为历史。**原始记录（todo）**：`..` 规则是整串正则，会命中引号内的惰性文本——`echo "see ../docs for details"`、`grep -n ".." src/index.ts`、`git log --grep "../ fixes"` 全部被判 `.. path escape is blocked`。该规则是用户「放宽不得削弱 `..`」条款点名保护的对象，NX-17 因此没有动它。收紧需要把判定从整串正则改为 token 级的路径操作数判定，且必须保持 `echo ../secret`、`cat ../secret`、`cp ../a b` 仍被拒；修改前先补需求/设计决策。
- **NX-23 URL 当请求目标，不分它是数据还是目标 — done（NX-32 顺带闭合，2026-10-01）**：粗粒度出网判据删掉了「整 token 恰为 URL 即拦」那条规则，`git log --grep "https://github.com/x"` 与 `npm install --registry https://registry.npmjs.org` 因此放行，矩阵里两行先读到 `met` 再搬进新契约组 `closed: NX-23 URL as data`。**这不是修好了，是那条规则不存在了**；代价是「非段首的 URL 操作数」这一侧同时张开（`git clone <url>` 不再被拦，登记为 `known gap NX-32 url operand`）。以下为发现时的原文，保留为历史。**原始记录（todo）**：出网规则对「整 token 恰为 URL」的形态**与命令段无关**，于是 `git log --grep "https://github.com/x"`、`npm install --registry https://registry.npmjs.org`、`git remote add origin https://…` 与 `curl https://…` 同判为 `unauthorized outbound request`。这是 NX-17 的 CHANGES 已点名的残留（当时用 `echo`/`printf` 能力判据只修掉了惰性输出那一半）。**属「放宽」方向**，且修它必须引入「哪些位置算 URL 消费位置」这类子命令知识——与仓库「判据取形状与能力，不取出现位置」正面冲突，所以不塞进 NX-19。直接证据是形状判定的不对称：`git log --grep=<url>` 放行而 `git log --grep <url>` 拒绝，同一条语义两种结果。改前先补需求/设计决策。
- **NX-25 here-doc 正文被当命令词 — done（2026-10-02，零付费；NX-24 期间从 NX-24-③ 拆出）**：现行契约见 PLAN D-18 与 R-20。`cat <<'EOF'` 的数据正文跳过，`bash <<'EOF'` 的脚本正文递归检查；缺终止词或超过数量／字节／递归上限拒绝。782 次真实 bash 调用里 5 次用到 `<<`（0.6%），其中 1 条 NX-28 误拒由本项消除；另 1 条 here-doc 调用仍因命令行本身写 `/tmp` 而正确留在 NX-27。

### NX-25 here-doc 正文按消费者分流

| 子步骤 | 行为与状态 | 验收 | 预计提交 |
|---|---|---|---:|
| NX-25-0 | 立项、PLAN 决策与 R-20 契约（**done**，`f04251d`） | `grep -cE '^\| NX-25-' docs/context-budget/TASKS.md` = 4；PLAN 新增 D-18，明确消费者闭集、配对语义、16 份／256 KiB／3 层上限与替代方案；R-20 不再把全部 here-doc 正文列为边界 | 1 次 |
| NX-25-1 | 识别、剥离与 shell 消费者递归（**done**，`c214059`） | `cat`／`node` 数据正文里的 `curl`、`/etc`、`a:\\tb` 放行；`bash`／`sh`／路径前缀 shell 正文里的 `curl`、`rm -rf`、系统路径拒绝；`<<WORD`／`<< WORD`／引号定界符／`<<-`／多份正文与正文后的命令均有回归；矩阵 NX-25 先读到 `met` 再搬组 | 1 次 |
| NX-25-2 | 失败闭合与宽度上限（**done**，`9759b38`） | 缺终止词、超过 16 份、累计正文超过 256 KiB、递归超过 3 层分别以独立理由拒绝；边界值放行；关掉每个守卫时对应反例翻面 | 1 次 |
| NX-25-3 | 回放、全量验证与文档回填（**done**） | `nx24-replay-probe.mjs` 的 NX-28 条目按实测移出拒绝集合且其余集合不漂移；README／PROGRESS／CHANGES／TASKS 与现行边界一致；`pnpm check`、`pnpm test`、`pnpm lint`、`pnpm fixtures:check`、`pnpm eval:offline`、`pnpm eval:estimate` 全绿 | 1 次 |
- **NX-27 Git Bash 的 `/tmp` 与 `node:path` 不一致 — done（2026-10-02，零付费）**：现行契约见 [NX-27 一节](#nx-27-windows-git-bash-的-tmp)、PLAN D-19 与 R-20。Windows 上 `/tmp` 映射到 `os.tmpdir()` 后复用 `resolveInside`；其他平台、其他根与文件工具不放宽。782 次真实调用的拒绝由 6 条降到 2 条，消失的恰为 4 个 NX-27 指纹。
- **NX-28 引号成词的正文以 `<字母>:\` 开头被判为盘符路径 — done（NX-25 连带闭合，2026-10-02）**：盘符判据本身未放宽；`node --input-type=module <<'EOF'` 的正文自 NX-25 起作为非 shell 数据剥离，不再进入路径扫描。回放指纹 `c7475a2f5e` 由 deny 变 allow，已从 `nx24-replay-probe.mjs` 的断言集合删除；其余 6 条拒绝不漂移。
- **NX-29 正则字面量与绝对根路径同形 — todo（NX-24-6 回放逐条定位）**：单引号 payload 里出现未转义的 `'` 时，tokenizer 会像 shell 一样在那里断开引号区间，于是 `assert.match(e.message, /missing/);` 里的 `/missing` 成了一个**独立 token**——而它与「真实读取根目录的 `/missing`」在形状上**完全相同**，没有任何可用判据。这不是闸门漏检：闸门在这里与 shell 一致，模型的命令本身引号就是坏的（`node -e '…x = 'a:b';…'`，bash 靠引号拼接才凑出合法 JS）。782 次调用里 1 条。可能的处置是**给引号坏掉的命令更明确的拒绝理由**（现在是含糊的 `path escapes the workspace`），而不是放宽路径判据——放宽就等于承认 `/missing` 不是路径。
- **NX-31 命令位置被包装命令与进程替换吃掉 — todo（NX-30 期间新发现）**：与本族同一个根因——`executable` 是命令段起点的唯一定义，而被吃掉的命令位就再也不开取网模型。**这一族 TASKS 此前没有登记，是 NX-30 期间实测挖出来的**：① **包装命令**——`env curl example.com`、`nice curl example.com`、`timeout 5 curl example.com`、`command curl example.com`、`find . -name x -exec curl example.com ;` 今日全是 allow（NX-19 的 `-c` 抽取之所以能覆盖 `env bash -c '…'`，是因为那条通道**不以 `executable` 为前提**；换成包装命令直接跟取网工具就漏）；② **进程替换** `<(curl x)`——`(` 不在算子集里，与 NX-30 修的子 shell 同形但走的是重定向那条臂。**方向与 NX-26／NX-30 相同（收紧）**，但机制不同：要新增一份**包装命令的工具知识表**，逐个说清「操作数里哪个才是命令」——`env -i A=1 cmd`（跳过 `-i` 与赋值）、`nice -n 5 cmd`（跳过 `-n N`）、`timeout -k 5 10 cmd`（跳过时长与 `-k N`）、`xargs -n1 cmd`（跳过自己的旗标），与 D-12 记录过的「不采用按工具清单收窄」那条决策正面相邻，须先定边界。矩阵已加两行 `known gap NX-31` 让①的暴露不被静默。语料 0 处（782 次调用里 `exec` 0 次、真实赋值 0 次、前导重定向 0 次），加它买的是必要性不是安全性。**NX-30 的剩余半**（`case … in a)` 臂体、`exec` 与赋值／重定向前缀）留在 [NX-30 一节](#nx-30-子-shell-与分组的命令段起点)里标为未做，不另立条目。
- **NX-16 持久化结构化编程任务状态与可选 compaction — todo（条件阶段，依赖 NX-08）**：只有评测确认当前 task 膨胀仍是主要失败源后才实现 compaction；实施前必须修订 R-03/D-02 的“当前 task 所有 run 原文进入请求”契约，不能作为小优化塞入。范围见[路线图 M8](../INTERNSHIP_ROADMAP.md)。
- **NX-20 路线图状态段整体陈旧 — done（2026-10-02，零付费）（NX-09 期间发现）**：`docs/INTERNSHIP_ROADMAP.md` 是**带日期的记录**，line 3 已把源码基线评估定为「历史证据保留」，因此不能只改其中一处而让全文自相矛盾。已核实陈旧点至少四处：顶部注记与 line 215 的「真实模型实验额度尚未在本次任务中设定或使用」（已被 NX-08 的约 $4.96 推翻）、line 194 的 M5 出口「旧 57 条回归」（现为 200 条）、line 213/215 的 M7 出口、line 233-239 §6 的「当前可以写…完成 57 条回归及 Windows/Linux × Node 22/24 CI」（且「Linux」与 README 实际使用的「Ubuntu/Windows」不一致）。处置须**按该文件自己的惯例加一条带日期的修订注记**，不静默改写正文历史。按 NX-17 的先例（改前发现的相邻缺陷另立待办，不塞进当前提交），NX-09 只立项、不修。**本次处置（2026-10-02）**：按该文件自己的惯例在页首加了一条带日期的状态修订注记，**正文一字未动**（`git diff --numstat` 为 9 行新增、0 行删除）。上面这段里的行号引用随注记插入而漂移，这正是新注记与 [NX-20 一节](#nx-20-路线图状态段的带日期修订注记) 一律改引**标题与引文**的原因。
- **NX-21 会话锁的陈旧判定与操作者入口 — done（2026-10-02，零付费）（NX-10-5 期间发现）**：**本次处置**见 [NX-21 一节](#nx-21-会话锁的陈旧核验入口与显式移除)。方向定为**只补显式人工入口、不加 pid 存活判定**（PLAN 的持久化一节已写死「不仅凭 PID 自动移除」），形态定为**独立脚本** `pnpm session:lock <sessionId>`——因为 `src/plugins/cli.ts:38` 在建立 REPL **之前**就 `open`，斜杠命令在真正需要它的时刻根本不可达。检视只摆证据，解除要 `--remove --token <检视输出里的 token>`，token 对不上即拒；`open`／`close`／`quarantineTail` 一行未动。以下为发现时的原文，保留为历史。**原始记录（todo）**：`JsonlStore.open` 对任何已存在的 `writer.lock` 一律拒绝（`src/core/event-store.ts:40`），提示语要求「verify stale locks explicitly」，但仓库里**没有任何可脚本化的核验入口**——`quarantineTail` 要先抢同一把锁（`:17-20`），`src/plugins/cli.ts:36-40` 的启动恢复撞上崩溃过的会话直接抛错，也没有 `/recover`；锁体里写了 `{token, pid}`，但 pid 从不被读回用于存活判断。于是崩溃之后唯一的恢复路径是由人手工删掉那把锁，NX-10 的第三幕照实演示了这一步。**本次不修**（`src/` 一行未动，动它等于动既有锁语义）。设计前要先定方向：加 pid 存活判定（须处理 pid 复用与跨平台差异），还是只补一个显式的人工核验入口（CLI 子命令或写清的步骤）。
- **NX-22 文档内锚点失效（登记四处，实际 6 处）— done（2026-10-02，零付费）（NX-11 期间发现）**：**本次处置**见 [NX-22 一节](#nx-22-文档内锚点的逐个校验与口径订正)：新增 `test/docs-links.test.ts` 把全仓锚点做成回归（修前恰好 6 条红、其余 160 余条全过），修掉 6 处并按 `NX-08-REPORT` 的成本表订正三处互相矛盾的数字。以下为发现时的原文，保留为历史。**原始记录（todo，四处）**：NX-11 把「相对链接与锚点目标逐个命中」做成可核对的检查时发现四处**仓库内**锚点指向不存在的标题——文件存在、锚点不存在，点击后停在页首。① `docs/context-budget/TASKS.md` 里两处 `#其他待办按依赖排序`（NX-10 的「已完成」条目里链向 NX-21）：「其他待办，按依赖排序：」在文件中是**正文**而不是标题，所以根本没有这个锚点；修法是把链接指到 NX-21 条目本身，或去掉链接。② `PROGRESS.md` 链 `CHANGES.md#nx-08f-4b-真实模型烟测--done2026-10-01付费约-003--…` 与 `…#nx-08f-4c-重跑烟测--done2026-10-01付费约-004--…`：CHANGES 的标题写的是 `付费约 $0.02` 与 `付费约 $0.03`，与链接里的 `003`／`004` 对不上。**②不只是锚点问题**：同一处 CHANGES 的 f-4b 标题写 `$0.02` 而紧邻正文写「成本：约 **$0.03**」，PROGRESS 的两条分别写 `$0.03`／`$0.04`——三个数字互相矛盾，**修之前要先定哪个是权威口径**（按价格页重算或按 NX-08g 的标注方式处理），属需要判断的那一类。按 NX-17 的先例，NX-11 只发现、不修：它既不属于本项范围，也不该把一条口径判断塞进文档回填的提交。
- **T6 Biome 只读诊断与处置 — done（2026-10-02，零付费）**：**本次处置**见 [T6 一节](#t6-biome-的收窄配置与处置)。诊断把「修到绿」的价格算出来了：Biome 的 `lineWidth` 上限 320 小于仓库最长行 732，**格式化不可满足**；两种 `--write` 各触及 210／211 个文件，且都会打破 `test/estimation.test.ts` 的钉版哈希与 `test/decisions-doc.test.ts` 的三十行锚点。用户据此选定**收窄配置、不设门禁**：新增 `biome.jsonc`（跟随 `.gitignore`、排除**故意写坏的** `test/fixtures/`、有意关闭 formatter 与 organizeImports、只关三条与刻意写法冲突的规则），逐条修掉它抓到的发现，`pnpm lint` 从 545 errors 变成 **0 诊断**。**既不是「移除 Biome」也不是「修到绿」**——`src/core/token-estimator.ts` 一个字节未动，这正是本方向能成立而修绿不能的关键。以下为发现时的原文，保留为历史。**原始记录（todo）**：先诊断告警数量与类别、评估修绿成本，再由用户选择修到绿并设为门禁、或移除 Biome；选定前不修改 Biome、依赖或 CI 门禁。

## 已完成

- **NX-11 整理设计取舍（五节）— done（2026-10-01，零付费）**：M9 的最后一块。新增 [DECISIONS.md](DECISIONS.md)，把「事件与投影分离、协议完整性、可靠编辑、验证时效、未知副作用恢复」五条选择各写成一节：**替代方案及其具体失效 → 代码锚点 → 测试锚点 → 代价**，并在结尾给出五条选择 → 规范出处 → 可跑演示的总表。它定位成 [PLAN](PLAN.md) 的**非规范性说明**（`AGENTS.md` 的文档入口写明 PLAN 是技术取舍与默认参数的唯一维护位置），因此不复述决策编号与数值，README／PLAN／AGENTS 三处入口都写了这一句。每条替代方案标 `【决策时记录】`／`【事后重构】`，30 条里 21 条有同期出处。**锚点可机读**：固定三列表格由新增的 `test/decisions-doc.test.ts` 解析，断言文件存在、行号不越界、说明列的首个 token 落在锚点上下 5 行内、测试名逐字命中，并强制每节各有代码与测试锚点——该测试当场抓出三处人写的漂移。反例实跑证明它有效：行号改成越界值 → 红；改成范围内的 `:19`（说明 token 太远）→ 也红。**只增文档与一个测试，`src/` 一行未动**。子步骤提交：`747e8a8`（立项）、`1f235c1`（骨架与第 1 节）、`ebc8623`（协议完整性）、`316c233`（可靠编辑）、`12a7a88`（验证时效）、`905e315`（未知副作用恢复与总表）、`f19fb3e`（锚点回归与计数订正）、`b98bb83`（三处入口）、本提交（回填）。验收：`pnpm check` 90 文件、`pnpm test` 203/203、`pnpm fixtures:check` 15 项、`pnpm eval:offline` 12/12。[详细证据](CHANGES.md#nx-11-整理设计取舍五节)。
- **NX-10 固定代码修复演示（三幕）— done（2026-10-01，零付费）**：M9 演示件。三条独立入口，全部由预设的脚本化模型驱动，不读 `.env`、不出网、不调用付费 API，**`src/` 一行未动**。① `pnpm demo:fix`：新增带项目规则的 fixture `repair`（两条 `AGENTS.md` 分居根目录与 `src/` 两个作用域），走通项目规则 → 定位 → 部分修复 → 失败检查（退出码 1 且失败点名未修的那条规则）→ 再修复 → 通过并落成验证记录 → `task_changes` 的真实 diff 与 `task_report` 的覆盖/检查记录，最后用工作区之外、模型与 Harness 都看不到用例的独立验收判定。② `pnpm demo:resume`：首段把请求预算压到 4 次，第 4 次请求带回的编辑在派发之前被拦下（无 `tool/start`），恢复后补做；逐条核对 `continuations=1`、无工具被重放、两段 run 的前后关系。③ `pnpm demo:unknown`：子进程执行一条写下真实副作用文件后阻塞的命令，父进程按进程树杀掉它，磁盘上留下真的残局——一条只有 `tool/start` 的调用与一把没人释放的 `writer.lock`；恢复走的是显式删锁之后的生产 `restore`，补出恰好一条 `status:'unknown'` 并挡住自动续跑。注册表新增 `demoIds`，`pnpm fixtures:check` 由 14 项变 15 项。**两条只有真跑才会暴露的坑已修并留在注释里**：适配器必须按「哪几步真的被回答了」推进（按请求次数推进会让被跳过的编辑在恢复时凭空消失），以及判断「已回答」要取最后一条同名结果（取第一条会把补做的步骤判成未回答，无休止重发）。同时立项 NX-21（会话锁的陈旧判定与操作者入口，本次只立项不修）。验收：`pnpm check` 89 文件、`pnpm test` 202/202、`pnpm fixtures:check` 15 项、`pnpm eval:offline` 12/12，三条演示连跑多次均退出 0。九个子步骤提交：`ce7dc6f`（立项）、`92b64ef`（fixture）、`333ab2c`（三态基线）、`89405c8`（第一幕）、`3439388`（第二幕）、`82dc7bd`（第三幕）、`1577b38`（陈旧锁用例）、`a310a34`（README 演示一节与计数）、本提交（回填 + NX-21）。[详细证据](CHANGES.md#nx-10-固定代码修复演示三幕)。
- **NX-09 README 定位、原创增量、架构图与零密钥运行入口 — done（2026-10-01，零付费）**：M9 的入口件。README 从「只有功能小节」补齐为读者面向的介绍：开篇加**定位与范围/非目标**（多 Agent 与托管平台、向量记忆、操作系统级隔离、费用硬上限、任意执行位置的精确恢复五项明确不做，每条可在 PLAN 的 D-01 或路线图 §4.7 找到依据），加**教程基线与本项目的分界**表（分界点 `c5fc9c4`，五行对照，八条 git 命令逐条可复现：教程主线 11 个提交、基线 `.ts` 文件数 0、源文件 22、6 个工具、22 条测试、分界后第一个提交 `43e3829`），「结构」节加一张 Mermaid 架构图（请求路径、事件日志为唯一事实来源且投影由其派生、工具在 `tools/` 9 个与插件 2 个两处注册），「运行」节拆出**零密钥上手路径**（install → check → test → fixtures:check → eval:offline 五条，行尾注释是实测输出；不写墙钟承诺），新增 **「真实模型实验」** 一节链 [NX-08-REPORT](NX-08-REPORT.md) 并按路线图 M9 出口分列教程基线／独立扩展／真实模型结果／模拟回归。同时订正三处陈旧数字（README「当前 190 条测试」→ 200、`tools/` 工具清单 7 → 9、PROGRESS 主分支基线 195/13 → 200/14）。**该节内不含任何提升比例**（`grep -nE '提升|提高|优于|更好|最好|显著|效率|收益|成功率|%'` 输出为空），且不声称 CI 通过——本次没有对应 run，只写本地实测。**只改文档，未动 `src/`**。七个子步骤提交：`f315ab9`（立项）、`74d7995`（定位）、`fc1788f`（分界）、`72e263a`（陈旧数字）、`fcd2b14`（架构图）、`8f08de9`（零密钥路径）、本提交（实验报告 + 回填）。另立项 [NX-20](#nx-20-路线图状态段的带日期修订注记)（路线图状态段整体陈旧）。验收：`pnpm check` 84 文件、`pnpm test` 200/200、`pnpm fixtures:check` 14 项、`pnpm eval:offline` 12/12，四条均零付费。
- **NX-08g 评测报告与结论 — done（2026-10-01，零付费）**：新建 **[NX-08-REPORT.md](NX-08-REPORT.md)**，合并 NX-08d 筛查跑与 NX-08e 对照 A，按路线图 4.5 的「需要报告」清单逐项分列两个批次。含样本量、重复间波动（armA token 极差 1.82×、armB 1.68×，**波动量级不小于效应量级**）、失败案例（编辑失败全是写入保护、真失败 5 次全修复且 4 次挤在第 6 阶段、n=1 的仪器结论被 n=6 否证）、成本（约 $4.96）与不可行项（两批 `infeasible` 均为 0；对照 B、天花板型结论、精确账单列为本轮做不了的）。**引用 NX-08g0 的判据**，把「结局饱和」与「样本量小」作为**两条独立限制**分别陈述，harness 行为与真实模型能力分开写，不写任何提升比例。本步另外从原始事件补算了筛查跑的工具级统计（编辑失败率 2/17 = 11.8%、真失败 0 次），并把探针口径明确为「命令中含 `node -e` 的 bash 调用」，据此订正 armA 20 → 21、合计 95 → 96。[详细证据](CHANGES.md#nx-08g-评测报告与结论)。
- **NX-08e 对照 A：全历史 vs 现有裁剪 — done（2026-10-01，付费约 $4.8～9.6）**：1 条十四阶段序列 × 3 次重复 × 2 臂 = **6 次运行**，模型 `deepseek/deepseek-v4-flash`，两臂差异只有输入目标（1,000,000 / 65,536）。**处理 3/3 生效**：armB 首次裁剪落在第 8/6/6 阶段、受处理阶段 7/9/9（上一轮 6 阶段批次是 3 次里 1 次完全不触发）；第 14 阶段峰值均值 armA 150,228 vs armB 56,690，**差 2.65 倍**。用量 armA 19,861,006 token / 261 请求、armB 10,838,050 token / 247 请求——**armB 少 45.4% 的 token，但请求只差 5.4%、墙钟反而略长**，即裁剪省的是上下文规模而非步数或时间。508 条 usage **全部来自 provider**、估算回退 0 次。**6 次全部 `accepted=true`：结局饱和，本批回答不了「裁剪是否损害成功」**——不是样本量问题，而是二值结局在两臂都取满值，须与「只有 1 条 fixture 序列」分开写。[详细证据](CHANGES.md#nx-08e-对照-a全历史-vs-现有裁剪实测)。
- **NX-08e2-4（重启）把序列扩到十四阶段并按新规模重预注册上限 — done**：对照 A 的首次实测把 e2-3 基于 n=1 的「6 阶段足够」否证（3 次 armB 只有 2 次真正裁剪）。`pipeline` 先扩到 10 阶段、再扩到 14 阶段，每步沿用既有模式（新模块 + 公开检查 + SPEC 一节）；10 阶段诊断跑实测第 6 个阶段首次裁剪、后 5 个阶段受处理（64 请求 / 2,639,688 token、accepted=true），并据此得出「**越过阈值的绝对阶段号大致固定，与总阶段数无关**」——加阶段只增加越界之后受处理的阶段数（≈ 总数 − 5），**买的是「处理真的生效」而不是统计功效**。14 阶段诊断同批实测（132 请求 / 6,379,862 token / 566 秒、`accepted=true`）确认第 5 个阶段越界、后 10 个阶段受处理。上限重算为每臂 **1,400 请求 / 40,000,000 token**、`batchCaps` **{18, 3_200, 88_000_000}**：请求取理论上界（3 × 14 × 32 = 1344 → 1400），token 取「3 × 实测单条 × 2 倍余量」（3 × 2 × 6,379,862 → 40,000,000）。**这条 token 值先按外推写过一版并被实测推翻**——外推 3,884,608、实测 6,379,862，高 64%，因为 token 由每阶段请求数驱动而非阶段数线性外推；按外推定的 24,000,000 会让 S4 踩在硬中止闸门上跑。[详细证据](CHANGES.md#nx-08e2-4重启把序列扩到十四阶段并按新规模重预注册上限)。提交 `2c7f2f0`／`2373c22`／`ddb24dd`。
- **NX-08e2-6 按实测重预注册 `phaseCaps` 与单次 run 预算 — done**：`armA`/`armB` 由「各 72 次（12 任务 × 2 臂 × 3 次）」改为**各 3 次（1 条六阶段序列 × 3 次重复）**，`batchCaps` 由 156 次改为 **18 次（请求 1,600 / token 38,000,000）**——「一次运行」的含义从「一个单任务」变成「整条序列」。请求上限取理论上界（3 × 6 × 32 = 576→600），token 上限取实测两倍余量（3 × 2 × 2,188,159→15,000,000）。**这两组数字随后被 NX-08e2-4（重启）按十四阶段的规模改写为每臂 1,400 / 24,000,000**，见上条。同时**明确 `armA`/`armB` 就是对照 A 的两条臂**（全历史 / 现有裁剪），差异压缩到输入目标一个参数（`armPolicy`，窗口不高于 armB 目标时直接失败）；对照 B 因此不再有对应阶段，其上限留待 NX-08f 前单独预注册。两项待办（NX-18／NX-19）不受影响。[详细证据](CHANGES.md#nx-08e2-6-按实测重预注册-phasecaps-与单次-run-预算)。
- **NX-08e2-2 真实适配器入口按阶段参数化 — done**：`--phase`（默认 `screening`）与 `--plan-only`（不落盘、不出网、无需密钥）；默认清单改为按阶段注册表取，**修掉 NX-08e1-1 遗留的「不带 `--tasks` 时计划 13 项对 12 次上限」缺陷**；`--tasks` 跨阶段取任务直接报错点名；参数与计划判据抽成 `scripts/eval-cli.ts` 的纯函数以便离线验收；新增 `batchPhases`，`batchCaps` 改为只归约预注册的三个对照阶段，诊断阶段 `phaseCaps.sequence` 单独预注册为 runs 1 / requests 192 / tokens 12,000,000；`pnpm eval:sequence` 入口。[详细证据](CHANGES.md#nx-08e2-2-真实适配器入口按阶段参数化)。
- **NX-08e2-1 逐阶段投影观测进入 `RunOutcome.tasks` — done**：`RunTaskDetail` 增加该阶段最后一次与最大估算输入、投影次数、首次裁剪的投影序号、被移除任务 id 并集、未发出投影数与 usage 来源分列；纯函数 `summarizeStage` 只读事件、不改生产状态，`session-runtime` 的 D-08 语义未被污染。[详细证据](CHANGES.md#nx-08e2-1-逐阶段投影观测进入-runoutcometasks)。提交 `6978f63`。
- **NX-08e1-1 新增多阶段依赖 fixture 并让注册表区分筛查批次 — done**：`pipeline` 是第一个声明 `TASKS/*.md` 的真实 fixture——六阶段在同一会话内按序下发，后阶段复用前阶段写下的模块（公开检查按阶段累积，06 反向解析自己 05 的渲染格式）；注册表拆成 `screeningIds`（12 个单任务，冻结）与 `sequenceIds`，`eval:offline` 改用前者。提交 `2c61a58`；[详细证据](CHANGES.md#nx-08e1-1-新增多阶段依赖-fixture-pipeline-并区分筛查批次)。
- **NX-08e1-2 离线覆盖多阶段驱动路径 — done**：补齐 e0-2 声明未覆盖的三条——6 阶段各自的 `taskId` 与 `counters` 逐字段求和、基础设施失败中止后续阶段且第三阶段正文一次未下发、筛查上限与 `screeningIds` 同步。提交 `ed95858`；[详细证据](CHANGES.md#nx-08e1-2-离线覆盖多阶段驱动路径)。
- **NX-08e1-3 fixture 契约与基线回填 — done**：PLAN 记录 fixture 契约与阶段数依据，TASKS/PROGRESS 同步计数与下一步；同时记下模拟适配器流量下序列峰值仅 13,614、不足以判断阶段数是否够这一负面事实。本批三个提交一次性推送，[CI 36693778212](https://github.com/BeforeLanding/mini-DSH/actions/runs/36693778212) 在 tip `c554bab` 上四组 success、attempt=1——**只有 tip 的 run，没有逐提交证据**。[详细证据](CHANGES.md#nx-08e1-3-fixture-契约与基线回填)。
- **NX-08e0-3 离线量化裁剪触发所需的旧任务规模 — done**：诊断探针 `docs/context-budget/nx08e-prune-probe.mjs` 给出实测换算——固定开销 1,909 token，每阶段 2,000／8,000／32,000 token 分别在**第 31／8／2 个阶段**触发裁剪，触发后进入「每新增一个阶段就丢掉最旧的一个」的滚动状态。据此，与现有 fixture 真实峰值（17,220／27,147）同量级的阶段约需 3～4 个才能越过 65,536。不调真实模型。[详细证据](CHANGES.md#nx-08e0-3-离线量化裁剪触发所需的旧任务规模)。
- **NX-08e0-2 评测驱动支持同一会话内的任务序列 — done**：`readTaskSequence` 支持 `TASKS/*.md` 布局（按文件名排序）并与 `TASK.md` 互斥，`TASKS/` 无 `.md` 时报错而不静默退回单任务；`runFixtureTask` 按 `fixture.tasks` 顺序在同一 session 内 `send`，`RunOutcome` 增加 `tasks` 逐阶段明细、`counters` 改为各阶段之和、`status` 取最后一个阶段，非 `BudgetStop` 的基础设施失败中止后续阶段；`task` 字段由 `tasks` 取代。提交 `18a50cc`，[CI 36690199979](https://github.com/BeforeLanding/mini-DSH/actions/runs/36690199979) 在该 SHA 上四组 success、attempt=1；[详细证据](CHANGES.md#nx-08e0-2-评测驱动支持同一会话内的任务序列)。
- **NX-08e0-1 修正对照触发条件与需求（文档）— done**：把 NX-08e 前置从「规模问题」改为「会话组成 + 规模」，逐条给出 `context-runtime.ts:29,68-70`、`session-runtime.ts:135`、`eval-fixture.ts:42-50` 的依据；更正 27,147 的来源标注并与之 17,220 分列；CHANGES 三处加带日期的修正注记、原始数值保留；REQUIREMENTS 新增 R-21。提交 `a46d1fc`；[详细证据](CHANGES.md#nx-08e0-1-修正对照触发条件与需求文档)。
- **NX-17-3 NX-17 设计决策与文档回填 — done**：设计决策（形状判据、能力判据、明确不采用的网络工具清单方案）与未放宽清单写入 CHANGES，新增 R-20 固化命令策略契约，README 说明策略范围与已知缺口，另附可复跑闸门矩阵 `docs/context-budget/nx17-gate-probes.mjs`（诊断脚本，非 CI 门禁）；[详细证据](CHANGES.md#nx-17-沙箱命令闸门误判修复筛查跑发现)。
- **NX-17-2 出网规则改用能力判据 — done**：`echo`／`printf` 参数里的 URL 不再判出网，本段接管道时仍拦截，`||` 不计作管道；`curl`／`wget` 操作数、`git clone <url>` 照旧拒绝。提交 `c4a02ae`；[详细证据](CHANGES.md#nx-17-沙箱命令闸门误判修复筛查跑发现)。
- **NX-17-1 命令分词与路径形状修复 — done**：双引号按 shell 语义识别 `\"`（事故命令由 49 token 变为 6 token，注释不再暴露为独立 token）；纯分隔符串与「首个分量含空白」的双斜杠 token 不再当路径操作数，单个 `/`、系统路径、`//etc`、`//home/…`、UNC 与 `..` 全部照旧拒绝。提交 `5322291`；[详细证据](CHANGES.md#nx-17-沙箱命令闸门误判修复筛查跑发现)。
- **NX-08d 筛查跑（12 任务 × 1，首次真实模型调用）— done**：`deepseek/deepseek-v4-flash`（服务端回显 `deepseek-flash`）跑完 12 个 fixture，**原始分子/分母 12/12**，无拒绝、无不可行、无基础设施失败，因此无可报告的失败案例；81 请求 / 412,176 token（20.3% 与 5.2% 的整批上限），81/81 usage 来自 provider，成本约 $0.15；12 次全部 `completed` 且未触发任何裁剪或预算停止（最大估算输入 17,220）。[详细证据](CHANGES.md#nx-08d-筛查跑12-任务--1首次真实模型调用)。
- **NX-08d0-3 真实适配器评测入口与逐 run 证据落盘 — done**：`pnpm eval:screening` 接入真实 DeepSeek 适配器，含协议探测（请求 `deepseek-v4-flash` 时服务端回显 `model=deepseek-flash`）、模型名与窗口显式化、逐 run 事件日志与 `runs.jsonl` 落盘、逐 run 成本打印；烟测 `merge` 两次均 completed 且通过验收（5 请求 / 24,677 token，9 请求 / 119,689 token）；[详细证据](CHANGES.md#nx-08d0-3-真实适配器评测入口与逐-run-证据落盘)。
- **NX-08d0-2 评测 run 结论分类与显式成功率口径 — done**：`RunOutcome` 增 `acceptance` 与 `infeasible`，`summarize` 输出 `rate { numerator, denominator, excludedInfeasible, excludedErrored }`，三类结果分别进入正确口径；[详细证据](CHANGES.md#nx-08d0-2-评测-run-结论分类与显式成功率口径)。
- **NX-08d0-1 评测预算接入上下文目标与模型窗口能力 — done**：修复评测路径上输入目标 65,536 与 1,000,000 窗口从未生效（投影不裁剪、`context_overflow` 不触发）的问题，新增 `evalPolicy` 与适配器 `capabilities` 透传；[详细证据](CHANGES.md#nx-08d0-1-评测预算接入上下文目标与模型窗口能力)。
- **NX-08c 输入估算误差实验 — done**：40 个样本（中文、英文、代码、schema 各 10）对照 DeepSeek 官方离线 tokenizer，四类均有相对误差分布与低估幅度；结论标注估算器 SHA-256 与核验日期 2026-09-30。自然语言一致高估（中文 +28%、英文 +40%），结构化载荷 4/40 低估、最深 −22.5%，超过 10% 的容量余量；[详细证据](CHANGES.md#nx-08c-输入估算误差实验)。
- **NX-08b 评测运行器与整批上限强制 — done**：`scripts/eval-runner.ts` 按阶段串行执行并核算 runs/requests/tokens 累计值，触顶中止阶段且不记作任务失败，已开始的 run 不被中途终止；`scripts/eval-fixture.ts` 提供适配器注入的 fixture 驱动，`pnpm eval:offline` 用模拟模型跑完筛查阶段全部 12 个任务；单次预算与整批上限的分工已写入 [PLAN](PLAN.md#nx-08-评测批次上限预注册)；[详细证据](CHANGES.md#nx-08b-评测运行器与整批上限强制)。
- **NX-08a 评测批次上限与事件导出契约 — done**：`context/projection` 带可选 `requestId` 并与随后 `model/start` 同号，未发出的请求因此可辨；`requestTrace` 增 `projectionLink`、`unsentProjections`，并补齐 run 终值 `counters`（含主动与审批时间）；[详细证据](CHANGES.md#nx-08a-评测导出契约与投影归属)。
- **OPS-01 停止文档提交触发生产部署 — done**：提交 [2ac85bd](https://github.com/BeforeLanding/mini-DSH/commit/2ac85bd1bcd69b85ed0329847cf3791a87472bd4)、纯文档探针 `92507d4`、[CI 36662206000](https://github.com/BeforeLanding/mini-DSH/actions/runs/36662206000)；[详细证据](CHANGES.md#ops-01-停止文档提交触发生产部署)。
- **OPS-02 CI push 路径过滤 — done**：提交 [263d439](https://github.com/BeforeLanding/mini-DSH/commit/263d439efd064ba27870dd8b2e6d95c11e581430)、[CI 36662938984](https://github.com/BeforeLanding/mini-DSH/actions/runs/36662938984)、纯文档提交 `ef46988` 为 0 个 run/check；[详细证据](CHANGES.md#ops-02-ci-push-路径过滤)。
- **OPS-03 文档当前状态化 — done**：PROGRESS 归档提交 `ef46988`；TASKS/CHANGES 证据迁移为本步提交；[详细证据](CHANGES.md#ops-03-文档当前状态化)。
- **OPS-04 修订提交粒度规则 — done**：以独立回退与可观察行为差异为判据，按能力类别分组 fixture；[详细证据](CHANGES.md#ops-04-修订提交粒度规则)。
- **OPS-05 版本标签与发布锚点 — done**：定义 `vMAJOR.MINOR.PATCH`、CI 前置、不可移动标签、Release 与回滚映射；[详细证据](CHANGES.md#ops-05-版本标签与发布锚点)。
- **NX-04 文档当前/历史状态清理与 F1–F3 回归接入 CI — done**：文档歧义由 OPS-03 处理；F1 回归见 `test/context.test.ts` 的投影输出额度重算用例（`mode === 'exact'` 保留旧任务并发 100 输出额度），F2 见 `test/deadline.test.ts` 的终态 sync 跨 deadline、有界收尾与错误路径独立上界用例，F3 见 `test/store.test.ts` 的崩溃重放投影合并用例；三者随 `pnpm test` 进入四组合 CI。详见 [CHANGES](CHANGES.md#f1-输出额度与历史裁剪联动)。
- **NX-06 请求 trace 与编程结果报告 — done**：提交 [08158b9](https://github.com/BeforeLanding/mini-DSH/commit/08158b9)、[CI 36661121345](https://github.com/BeforeLanding/mini-DSH/actions/runs/36661121345)；[详细证据](CHANGES.md#nx-06-请求-trace-与编程结果报告)。
- **NX-05b 将编程任务集扩展到 12 项 — done**：提交 [53e5aba](https://github.com/BeforeLanding/mini-DSH/commit/53e5aba)、[CI 36657576782](https://github.com/BeforeLanding/mini-DSH/actions/runs/36657576782)；[详细证据](CHANGES.md#nx-05b-将编程任务集扩展到-12-项)。
- **NX-15 编程验证记录与交付报告 — done**：提交 [87360a1](https://github.com/BeforeLanding/mini-DSH/commit/87360a1)、[CI 36653379987](https://github.com/BeforeLanding/mini-DSH/actions/runs/36653379987)；[详细证据](CHANGES.md#nx-15-编程验证记录与交付报告)。
- **CD-02 修复服务器 GitHub 下载失败 — done**：提交 [c9f452c](https://github.com/BeforeLanding/mini-DSH/commit/c9f452c)、[Deploy ECS 36574173979](https://github.com/BeforeLanding/mini-DSH/actions/runs/36574173979)；[详细证据](CHANGES.md#cd-02-修复服务器-github-下载失败)。
- **CD-01 阿里云 CLI 发布 — done**：提交 [a632121](https://github.com/BeforeLanding/mini-DSH/commit/a632121)、[Deploy ECS 36550955877](https://github.com/BeforeLanding/mini-DSH/actions/runs/36550955877)；[详细证据](CHANGES.md#cd-01-阿里云-cli-发布)。
- **NX-14 结构化命令执行结果 — done**：提交 [557f27f](https://github.com/BeforeLanding/mini-DSH/commit/557f27f)、[CI 36651228195](https://github.com/BeforeLanding/mini-DSH/actions/runs/36651228195)；[详细证据](CHANGES.md#nx-14-结构化命令执行结果)。
- **NX-13 可靠编辑、冲突与变更交付 — done**：提交 [4c9501c](https://github.com/BeforeLanding/mini-DSH/commit/4c9501c)、[CI 36545691239](https://github.com/BeforeLanding/mini-DSH/actions/runs/36545691239)；[详细证据](CHANGES.md#nx-13-可靠编辑冲突与变更交付)。
- **NX-12 coding profile 与仓库上下文 — done**：提交 `c5dd04b`～`20e8e3b` 及最终集成证据；[详细证据](CHANGES.md#nx-12-coding-profile-与仓库上下文)。
- **NX-12 Windows 短路径 junction 修复 — done**：[详细证据](CHANGES.md#nx-12-ci-修复windows-短路径-junction)。
- **NX-05a 三个编程 fixture 与独立验收 — done**：[详细证据](CHANGES.md#nx-05a-三个编程-fixture-与独立验收)。
- **F1 输出额度与历史裁剪联动 — done**：[详细证据](CHANGES.md#f1-输出额度与历史裁剪联动)。
- **F2 最终持久化 deadline 与提交不确定性 — done**：[详细证据](CHANGES.md#f2-最终持久化-deadline-与提交不确定性)。
- **F3 崩溃恢复的投影观测一致性 — done**：[详细证据](CHANGES.md#f3-崩溃恢复的投影观测一致性)。
- **CB-00 文档基线 — done**：[详细证据](CHANGES.md#cb-00-文档基线)。
- **CB-17 恢复开发基线 — done**：[详细证据](CHANGES.md#cb-17-恢复开发基线)。
- **CB-15 TypeScript 工具链与迁移 — done**：[CI 36504218629](https://github.com/BeforeLanding/mini-DSH/actions/runs/36504218629)；[详细证据](CHANGES.md#cb-15-typescript-工具链与迁移)。
- **CB-01 配置与预算契约 — done**：[详细证据](CHANGES.md#cb-01-配置与预算契约)。
- **CB-02 执行状态与事件 — done**：[详细证据](CHANGES.md#cb-02-执行状态与事件)。
- **CB-11 JSONL 事件存储 — done**：[详细证据](CHANGES.md#cb-11-jsonl-事件存储)。
- **CB-03 模型 usage 与输出限制 — done**：[详细证据](CHANGES.md#cb-03-模型-usage-与输出限制)。
- **CB-12 Session 重建与未知执行识别 — done**：[详细证据](CHANGES.md#cb-12-session-重建与未知执行识别)。
- **CB-04 请求 token 估算 — done**：[详细证据](CHANGES.md#cb-04-请求-token-估算)。
- **CB-05 上下文裁剪与输出投影 — done**：[详细证据](CHANGES.md#cb-05-上下文裁剪与输出投影)。
- **CB-06 步数与工具调用调度 — done**：[详细证据](CHANGES.md#cb-06-步数与工具调用调度)。
- **CB-07 Deadline 与用户取消 — done**：[详细证据](CHANGES.md#cb-07-deadline-与用户取消)。
- **CB-08 累计 token 预算接入 — done**：[详细证据](CHANGES.md#cb-08-累计-token-预算接入)。
- **CB-13 预算停止后的 `/continue` — done**：[详细证据](CHANGES.md#cb-13-预算停止后的-continue)。
- **CB-09 CLI 与用户文档 — done**：[详细证据](CHANGES.md#cb-09-cli-与用户文档)。
- **CB-10 集成验收与交接 — done**：[CI 36508829785](https://github.com/BeforeLanding/mini-DSH/actions/runs/36508829785)；[详细证据](CHANGES.md#cb-10-集成验收与交接)。
- **CB-18 实习导向评估与后续规划 — done（评估）**：[CI 36514313704](https://github.com/BeforeLanding/mini-DSH/actions/runs/36514313704)；[详细证据](CHANGES.md#cb-18-实习导向评估与后续规划)。
- **CB-19 按 mini coding agent harness 定位修订路线 — done（文档）**：[详细证据](CHANGES.md#cb-19-按-mini-coding-agent-harness-定位修订路线)。
- **NX-07 有界代码读取、搜索与大结果回读 — done**：提交 [6c03300](https://github.com/BeforeLanding/mini-DSH/commit/6c03300)、[CI 36538591870](https://github.com/BeforeLanding/mini-DSH/actions/runs/36538591870)；[详细证据](CHANGES.md#nx-07-有界代码读取搜索与大结果回读)。
