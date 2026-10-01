# 任务清单

更新：2026-09-30。每项只保留当前状态和证据入口；行为、边界、逐步提交与完整验收记录见 [CHANGES](CHANGES.md)。状态：`todo`、`in_progress`、`blocked`、`done`。

## 待办

下一步主线是 **NX-08 真实模型任务对照**。整批上限、各臂一致的单次 run 预算与预注册口径见 [PLAN 的评测批次上限](PLAN.md#nx-08-评测批次上限预注册)；筛查跑（NX-08d）已于 2026-09-30 完成，预注册参数在开跑后不得再单独调整某一臂或某次重复。离线部分（a／b／c）与开跑前的设施补齐（d0）均已完成。

NX-08e 开跑前必须先解决其前置条件（2026-09-30 修正）：裁剪要求会话中存在**已结束且可裁剪的旧任务**，单任务会话无论多大都不会触发——当前 task 与 `/continue` 的续跑段恒受保护（依据见 [PLAN 的对照有效性条件](PLAN.md#nx-08 评测批次上限预注册)）。现有驱动每个 fixture 只发一次 `send`，因此筛查跑的 `removedTaskIds` 全为空属结构性必然。

前置设施 NX-08e0 三步均已完成：e0-1 修正条件与需求、e0-2 让驱动支持同一会话内的任务序列（契约见 [PLAN](PLAN.md#nx-08e0-阶段序列驱动契约)）、e0-3 离线量化越过输入目标所需的旧任务规模（实测同量级阶段约需 3～4 个）。

多阶段依赖 fixture 已落地并扩到**十四阶段**（`pipeline`，实现在 `test/fixtures/coding/pipeline/`，契约与阶段数依据见 [PLAN](PLAN.md#nx-08e1-多阶段依赖-fixturepipeline)）。e2 各步已完成：逐阶段投影观测（e2-1）、入口按阶段参数化与 `--plan-only`（e2-2）、真实模型烟测（e2-3）、验收放宽到 SPEC 的实际要求（e2-5）、按实测重预注册上限（e2-6），以及**重启后的 e2-4**——它把阶段数由 6 扩到 10、再扩到 14，因为 e2-3 基于 n=1 的「6 阶段足够」被 6 次运行的正式批次否证了。

**NX-08e 的正式批次已完成**（十四阶段 × 每臂 3 次重复 × 2 臂，证据在 `.eval-evidence/arm{A,B}-14stage/`，不入库）。逐项证据见 [CHANGES 的 NX-08e 节](CHANGES.md#nx-08e-对照-a全历史-vs-现有裁剪实测)。

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
| 探针使用 | `bash` 里含 `node -e` 的自写探针数 | armA 20（1/1/18）、armB 75（18/24/33）；同口径 `check.mjs` 调用 armA 52 / armB 66。方向一致但仍属行为观察 |

**「非零退出的验证」全批 9 次是个会高估的数**：按断言失败的阶段号与当前阶段的关系拆开是 1 次自写探针 + 3 次预期失败（跑了后面的检查）+ 5 次真失败。报告引用修复迭代时必须用后者。`runs.jsonl` 的设计目标是逐阶段预算与裁剪观测，不是工具级统计；引用这几项须说明来源是原始事件。

**成本口径此前用过三种方法，现已统一**：PLAN 的最坏上界（98M token ≈ $43，明写「不是计费承诺」）、`PROGRESS` 里没写推导的历史金额、以及本轮一度从既有花费反推的 $/M。**统一采用价格页直接计算**，并把缓存命中未记录这一已知偏高因素写进报告。历史金额（「约 $0.15／$1／$4」）不可复现，**引用时须按同一算法重算或标注**——本轮就因拿它当基准，把成本报高了约 2～3 倍。

**本批不支持「裁剪是否损害任务成功」的结论**：不是样本量问题，而是二值结局在两臂都取满值（6/6 全通过），没有失败可解释。这与「只有 1 条 fixture 序列」是两个独立的限制，报告须分开写。任务集对这档模型太容易——NX-08d 筛查跑 12/12 是同一个病的另一处表现。

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
| NX-08f | 对照 B：现有裁剪 vs 裁剪加有界工具输出 | 同 e 的模型、prompt、验收与单次 run 预算；两次比较的结论分开陈述，不合并收益。**不受 e 的会话组成前置限制**：有界工具输出改变的是当前 task 内部的历史规模，单任务会话下就会出现一臂 `context_overflow`、另一臂完成。**本轮没有为它预注册阶段与整批上限**（`phaseCaps` 的 `armA`/`armB` 已明确归属对照 A 的两臂），开跑前须单独预注册 | 1 次 |
| NX-08g | 评测报告与结论 | 含样本量、重复间波动、失败案例、成本与不可行项；不写未验证的提升比例，明确区分 harness 行为与真实模型能力 | 1 次 |

其他待办，按依赖排序：

- **NX-18 `..` 族误判 — todo（NX-17 期间发现）**：`..` 规则是整串正则，会命中引号内的惰性文本——`echo "see ../docs for details"`、`grep -n ".." src/index.ts`、`git log --grep "../ fixes"` 全部被判 `.. path escape is blocked`。该规则是用户「放宽不得削弱 `..`」条款点名保护的对象，NX-17 因此没有动它。收紧需要把判定从整串正则改为 token 级的路径操作数判定，且必须保持 `echo ../secret`、`cat ../secret`、`cp ../a b` 仍被拒；修改前先补需求/设计决策。
- **NX-19 出网拦截的真实缺口 — todo（NX-17 期间发现）**：`bash -c "curl http://example.com"`、`sh -c "wget …"`、`echo "$(curl …)"`、`nc example.com 80`、`ssh user@example.com`、反斜杠 UNC（`cat \\server\share\secret`）当前全部放行；其中反斜杠 UNC 与 NX-17 无关，是既有缺口。出网规则只覆盖「整个 token 是一个 URL 且位于命令词可识别的段内」，命令替换、内联脚本与未被识别的取网工具都在覆盖范围之外。收口属于「加强」而非「放宽」，需要单独设计与验收，不得顺手塞进 NX-17 的提交。
- **NX-16 持久化结构化编程任务状态与可选 compaction — todo（条件阶段，依赖 NX-08）**：只有评测确认当前 task 膨胀仍是主要失败源后才实现 compaction；实施前必须修订 R-03/D-02 的“当前 task 所有 run 原文进入请求”契约，不能作为小优化塞入。范围见[路线图 M8](../INTERNSHIP_ROADMAP.md)。
- **NX-09 README 增加定位、原创增量、架构图与 5 分钟运行入口 — todo**：不依赖 NX-08，可先行；真实模型结果一节须等 NX-08 完成后回填，不得提前填写期望提升比例。
- **NX-10 固定代码修复演示 — todo**：展示项目规则→定位→修改→失败测试→再修复→diff 与证据；另需展示预算停止/恢复和 unknown。
- **NX-11 整理设计取舍 — todo**：事件与投影分离、协议完整性、可靠编辑、验证时效、未知副作用恢复，须能从代码和测试解释选择。
- **T6 Biome 只读诊断与处置 — todo**：先诊断告警数量与类别、评估修绿成本，再由用户选择修到绿并设为门禁、或移除 Biome；选定前不修改 Biome、依赖或 CI 门禁。

## 已完成

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
