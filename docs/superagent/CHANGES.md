# 多 Agent 编排改动与证据

## M4-⑤-4 付费批次文档（2026-11-08）

- DECISIONS 新增 M4-⑤：固定计划、四臂同额预算与两项置 0 的理由、在途预留守卫、不提供 `decide`、复刻而非抽取隔离 preflight、先演练后授权。
- DEVELOPMENT §14.4 填入第一批的实际数值：每 run 上限 $1.7597，批次上限 $28.1742（峰值价，最坏情况，不是预计花费）。
- manifest 必须在本提交之后冻结：`--execute` 要求 HEAD 等于 manifest 记录的 commit。

## M4-⑤-3 `--execute` 闸门、协议探测与停批规则（2026-11-08）

**改动**

- `pnpm eval:orchestrate --execute --manifest FILE --evidence-root DIR --max-usd N`：唯一会付费的模式。模型只取自冻结 manifest（传 `--model` 或 `MINI_DSH_EVAL_MODEL` 即拒绝）；`--max-usd` 只接受十进制正数。
- 闸门全部在创建证据目录、发出任何请求之前完成：manifest 协议、价格、矩阵 digest、执行顺序与金额上限按当前代码重算后逐项一致；工作树干净且 HEAD 等于冻结 commit；`--max-usd` 不低于“探测 + 一个 run”的预留、不高于冻结的批次上限；`DEEPSEEK_API_KEY` 与 `MINI_DSH_V2_RUNTIME` 存在且隔离 preflight 通过；证据目录尚不存在。
- 协议探测与 eval-v2-run 同形：直连 `max_tokens 16` 校验服务端回显等于 manifest 的 `echoedModel`，流式一次校验 provider usage；失败写 `probe-error.json` 与 `stopReason=protocol_probe_failed` 的报告，不跑任何 run。探测预留整额计入已花费，批次守卫只拿剩余额度。
- 适配器与 eval-v2-run 同形（显式模型列表与 1M 窗口）；thinking 取适配器缺省，与生产 CLI 相同。真实依赖只在 CLI 中装配，测试全部注入脚本依赖。

**验证（本步实际输出）**

```text
node --test dist/test/eval-orchestrate*.test.js   # tests 21 / pass 21 / fail 0
#   每个闸门拒绝时证据目录不存在、探测与模型调用均为 0；探测回显不符即停批且无 run；
#   探测通过后第一个 run 出现未知用量即停批，报告 executedRuns=1、observedModel 已记录
pnpm check                     # syntax ok: 267 files
pnpm test                      # tests 682 / pass 652 / fail 0 / 30 platform-skipped
pnpm lint                      # 298 files, no fixes applied
```

本步没有发出任何真实请求；付费执行仍需用户对该次批次授权。

## M4-⑤-2 四臂执行器、并发安全金额守卫、按工作区的隔离与 `--rehearse`（2026-11-08）

代码在 `570bcd5`；该提交漏带本条证据，由后续文档提交补上（不 amend 已推送提交）。

**改动**

- `scripts/eval-orchestrate-arms.ts`：
  - 金额守卫与 `createSmokeAmountGuard` 同一预留口径（满 1M 上下文输入 + 满输出），另计**在途预留**——R 的两个 worker 并发请求时不会合计越过上限；缺 provider usage 后全部拒发。
  - 逐 run 计量在适配器层统一数请求、provider token、工具调用与 Bash 次数、峰值价 USD，四臂同一口径。
  - 按命令 cwd 向上找到所属 git 工作区（`.git` 目录或 worktree 的 `.git` 文件），各建一个隔离 runner——编排只接受一个共享 runner，而 bwrap runner 绑定单一工作区。
  - S/D 走 `createHarness` + 单 Agent（D 加只读委派与同额任务组预算）；R/R-serial 走 `orchestrate()` 固定计划、`maxWorkers` 2/1、`plannerShare = 0`、`fixReserveTokens = 0`，写入与 Bash 自动批准，不提供 `decide`（冲突即停为需人工，计入该臂）。结论一律由隐藏验收器给出。
  - 批次按 manifest 顺序串行；金额无法预留、未知用量、基础设施错误立即停批。
- `scripts/eval-orchestrate-run.ts`：隔离 preflight（与 eval-v2-run 同检查；不改 eval-v2-run，它在 eval-v2 的冻结清单里）、批次报告（逐 (任务, 重复) 配对 + 按臂汇总，不做显著性判断）、证据目录一次一用、`--rehearse`。
- `pnpm eval:orchestrate --rehearse [--evidence-root DIR]`：脚本模型写参考解并经隔离 runner 跑冒烟检查；给出 `MINI_DSH_V2_RUNTIME` 时用 WSL bwrap，否则在报告中标明 Bash 未隔离。

**验证（本步实际输出）**

```text
MINI_DSH_V2_RUNTIME='D:\Agent\tmp\nx42-runtime\unpack' node dist/scripts/eval-orchestrate.js --rehearse --evidence-root D:/Agent/tmp/orch-rehearse-01
# passed=true; providerRequests=0; scriptedRequests=72; isolation=wsl-bwrap; stopReason=completed; executedRuns=16
# 隐藏验收 S 4/4、D 4/4、R 4/4、R-serial 4/4；会话中 24 次 Bash 全部 isError=false，抽查为沙箱内 exit 0
node --test dist/test/eval-orchestrate*.test.js   # pass 17 / fail 0
pnpm check                     # syntax ok: 266 files
pnpm test                      # tests 678 / pass 648 / fail 0 / 30 platform-skipped
pnpm lint                      # 297 files, no fixes applied
```

演练证明的是管线（工作区、git/worktree、隔离、守卫、证据与报告），不是模型能力；脚本模型的 usage 是合成值，只用于驱动守卫。

## 修复：root/start 拒绝 `fixReserveTokens = 0`（2026-11-08）

**现象：** `resolveRootBudget` 有意允许 `fixReserveTokens` 为 0（`src/orchestration/orchestrator.ts`），但 `root/start` 事件校验（`src/orchestration/validation.ts`）要求它 ≥ 1。于是 `--root-budget '{"fixReserveTokens":0}'` 通过入口校验，根却在写第一条事件时失败（`budget.fixReserveTokens must be an integer >= 1`）。在为付费批次装配 R 臂时发现。

**改动：** 校验与 `resolveRootBudget` 对齐，`fixReserveTokens` 下限为 0，其余预算键仍为 1；新增回归测试，同时钉住 -1 与 `maxTotalTokens = 0` 仍被拒绝。

**验证（本步实际输出）**

```text
修复前  node --test dist/test/orchestration-store.test.js        # pass 4 / fail 1（新增用例）
修复后  node --test dist/test/orchestration-*.test.js            # tests 70 / pass 70 / fail 0
```

## M4-⑤-1 批次 manifest、金额上限与 `--plan-only`（2026-11-08）

**改动**

- 新增 `scripts/eval-orchestrate-batch.ts`：价格快照（2026-11-08 从官方价格页核对，峰值与 2026-10-27 快照相同：缓存命中输入 $0.006、未命中输入 $0.30、输出 $1.20 / 百万 token；非峰值为一半，上限一律按峰值）、与 `developmentReserveUsd` 同式的批次上限、按 (任务, 重复) 成块且偶数重复反转臂序的执行顺序、可移植的矩阵 digest、`wx` 不覆盖的 manifest。
- `pnpm eval:orchestrate --plan-only [--manifest-out FILE]`：打印矩阵、预算、模型、价格与上限；给出 `--manifest-out` 时冻结 manifest，工作树不干净即拒绝。只接受预注册的 `deepseek/deepseek-flash`。`--execute` 仍被拒绝。

**验证（本步实际输出）**

```text
node dist/scripts/eval-orchestrate.js --plan-only
# providerRequests=0; runs=16; perRunUsd=1.7597; batchUsd=28.1742
# 每 run = 1M × $1.20 × 1.2 + (1M × $0.30 + 16,384 × $1.20)/1M；批次另加 16,384 × $1.20/1M 的探测预留
node dist/scripts/eval-orchestrate.js --validate-only   # passed=true; providerRequests=0; runs=16
pnpm check                     # syntax ok: 263 files
pnpm test                      # tests 671 / pass 641 / fail 0 / 30 platform-skipped
pnpm lint                      # 294 files, no fixes applied
```

## v0.3.0 发布（2026-11-08）

**改动**

- `package.json` 0.2.0 → 0.3.0；README、PROGRESS、USAGE、RECRUITER_WALKTHROUGH 与 REQUIREMENTS 的 Release 链接与编排状态改为 v0.3.0。
- CI 仓库外安装 job：安装后的 `--help` 须含 `mini-dsh orchestrate run`，`orchestrate list` 无状态时须输出 `no orchestrations`。
- `test/progress-sync.test.ts`：新增“尚未发版”护栏，并把编排行的识别扩到 `orchestrate` 与里程碑区间。

**验证（本步实际输出）**

```text
# 先证红（版本已改为 0.3.0、文档未改）
node --test dist/test/progress-sync.test.js   # 2 fail：Release 链接 4 处仍为 v0.2.0；“尚未发版”护栏命中 8 行
# 改文档后
node --test dist/test/progress-sync.test.js dist/test/docs-links.test.js   # tests 6 / pass 6 / fail 0
pnpm check                     # syntax ok: 261 files
pnpm test                      # tests 665 / pass 635 / fail 0 / 30 platform-skipped
pnpm lint                      # 292 files, no fixes applied
# 按 CI 步骤：pnpm pack → 仓库外含空格目录 pnpm add --ignore-scripts
mini-dsh --version             # 0.3.0
mini-dsh orchestrate list      # no orchestrations
mini-dsh demo fix              # demo result: PASS
tarball                        # 184 files；dist/src/orchestration/ 34 个；无 test/docs/.env/samples
pnpm audit --prod（安装后）    # No known vulnerabilities found
```

**未包含**

- npm 发布；真实模型四臂付费批次（仍需对该次批次单独授权）。

## 合入 main 与文档同步（2026-11-08）

**改动**

- 分支链按里程碑合入 main：#25（开发文档）、#26（M0）、#27（M1）、#28（M2）、#29（M3）、#30（M4，含本条），均为 merge commit。
- README、PROGRESS、USAGE、RECRUITER_WALKTHROUGH 与 REQUIREMENTS 从“开发分支、待合并”改为“已在 main、尚未发版（v0.2.0 不含）”。
- `test/progress-sync.test.ts` 新增文档漂移护栏：`src/app/orchestrate-cli.ts` 存在时，五份用户文档中提到编排的行不得再写未合入 main。

**验证（本步实际输出）**

```text
# 先证红：只加护栏、未改文档时
node --test dist/test/progress-sync.test.js   # 1 fail：11 行命中（README 4、PROGRESS 2、USAGE 1、RECRUITER_WALKTHROUGH 3、REQUIREMENTS 1）
# 改文档后
node --test dist/test/progress-sync.test.js dist/test/docs-links.test.js   # tests 5 / pass 5 / fail 0
pnpm check                     # syntax ok: 261 files
pnpm test                      # tests 664 / pass 634 / fail 0 / 30 platform-skipped
pnpm lint                      # 292 files, no fixes applied
```

**未包含**

- 新版本 Release；真实模型四臂付费批次（仍需对该次批次单独授权）。

## M1 修复：worktree 清理在 8.3 短路径下失效（2026-11-08）

**现象：** PR CI 的 Windows 作业失败两项。runner 的临时目录是 8.3 短名（`C:\Users\RUNNER~1\…`），`git worktree list` 报告长路径（`C:\Users\runneradmin\…`）；`WorktreeManager.cleanup()` 按字符串前缀比对，没有一个 worktree 被认作本根任务的，`git branch -D` 因分支仍被 worktree 占用而失败。本机用户名没有短名，所以本地一直没暴露。

**改动**

- `src/orchestration/worktrees.ts`：`cleanup()` 比对前把编排目录与 git 报告的路径都经 `fs.realpath` 规范化（不存在时退回 `path.resolve`）。
- `test/orchestration-git.test.ts`：仓库根与 worktree 列表的期望值改为与 `fs.realpath` 比较，而不是与可能为短名的临时路径比较。

**验证（本步实际输出）**

```text
# 把 TMP/TEMP 指向 8.3 别名 %LOCALAPPDATA%\Temp\LONGDI~1 复现
修复前  node --test dist/test/orchestration-git.test.js   # pass 1 / fail 2（与 CI 相同的两项）
修复后  node --test dist/test/orchestration*.test.js      # tests 28 / pass 28 / fail 0
修复后  node --test dist/test/*.test.js（短名 TEMP）       # tests 617 / pass 587 / fail 0 / 30 platform-skipped
pnpm lint                                                # 276 files, no fixes applied
```

## M4-④ 里程碑收尾与文档（2026-11-08）

**改动**

- README 新增“多 Agent 编排（开发分支，待评审合并）”与三个离线演示入口；评测与已知边界补充编排的离线装配与“付费批次未执行”。
- REQUIREMENTS、TASKS、PROGRESS、DECISIONS 同步 M4 离线完成状态；main 尚未合并的边界保持显式。
- `test/fixtures/orchestration/README.md` 记录两套验收（冒烟检查 vs 隐藏验收器）的分工。

**验证（本步实际输出）**

```text
pnpm check                     # syntax ok: 261 files
pnpm test                      # tests 663 / pass 633 / fail 0 / 30 platform-skipped
pnpm lint                      # 292 files, no warnings
pnpm demo:orchestrate-single   # PASS；scripted requests=3；planner requests=1；隐藏验收 1/1
pnpm demo:orchestrate-parallel # PASS；scripted requests=7；planner requests=1；隐藏验收 3/3
pnpm demo:orchestrate-crash    # PASS；scripted requests=6
pnpm eval:orchestrate --validate-only
# mode=validate-only; providerRequests=0; runs=16; passed=true; 初始态全部拒收、参考态全部通过; paidBatch.executed=false
```

**未包含**

- 真实模型四臂批次、费用上限与结果（需对该次批次单独授权）；D′ 与冲突/负对照任务集的预注册。
- 30 项 platform-skipped 仍由 CI 的 Linux isolation 作业覆盖，不声称本机通过。

## M4-③ 离线评测执行器（2026-11-08）

**改动**

- 新增 `scripts/eval-orchestrate.ts` 与 `pnpm eval:orchestrate`：四臂矩阵装配（S / D / R / R-serial）、公平性机械校验、`--validate-only` 的夹具正反例与零 provider 请求校验。
- `--execute` 被显式拒绝：本步未接线真实模型批次；付费批次需按 §14.4 单独授权，结果另成证据提交。
- D′（关闭治理）与 §14.3 的“冲突型/负对照”任务类别列为未装配，输出中带原因，不默认视为已覆盖。

**验证**

```text
pnpm typecheck                 # 通过
pnpm build                     # 通过
pnpm lint                      # 292 files, no warnings
node --test dist/test/eval-orchestrate.test.js
# tests 5 / pass 5 / fail 0
pnpm eval:orchestrate --validate-only
# mode=validate-only; providerRequests=0; runs=16; task 2; 初始态全部拒收、参考态全部通过
```

**测试覆盖**

- 矩阵 = 2 个夹具 × 4 臂 × 2 次重复 = 16；同一任务的预算/验收器/目标逐字一致；R 与 R-serial 只差 `maxWorkers` 且共享计划；S/D 不接收编排计划，D 的 delegation 为 read-only。
- 篡改预算、worker 数或删掉一整臂都会使 `validateRunMatrix` 失败。
- `--validate-only` 运行隐藏验收器的正反例（初始拒收、参考通过），provider 请求为 0，付费批次标记为未执行。
- `--execute`、无参数与未知参数均被拒绝；环境变量模型名可进入装配清单。
- 哨兵适配器一旦被调用就抛错并计数，防止离线装配悄悄接入 provider。

**未包含**

- 真实模型批次与费用上限（需单独授权）；S/D 的执行适配器接线；D′ 与冲突/负对照任务集（随授权批次预注册）。

## M4-② 单/并行演示（2026-11-08）

**改动**

- 新增 `scripts/demo-orchestrate.ts` 与 `demo:orchestrate-single`、`demo:orchestrate-parallel`：脚本模型 + 真实 git，不配置 provider、不发起付费请求。
- `single`：只读 planner 判定 `single`，一个 worker 完成 repair；报告打印 planner 请求/用量。
- `parallel`：planner 生成两波次计划；第一波两个 worker 的区间重叠，第二波 `st-3` 在整合 head 上读取前两个包的真实实现；报告打印两次整合与三条验收命令。
- 两个演示最后都在整合 worktree 上运行隐藏验收器，且断言用户工作树 HEAD/状态不变。

**验证**

```text
pnpm typecheck                 # 通过
pnpm build                     # 通过
pnpm lint                      # 290 files, no warnings
pnpm demo:orchestrate-single   # PASS；scripted requests=3；planner requests=1；用户工作树不变
pnpm demo:orchestrate-parallel # PASS；scripted requests=7；planner requests=1；两波次整合；用户工作树不变
```

**测试覆盖**

- `single`：`plan.source=model`、`mode=single`、一个 attempt、整合 applied=st-1、验收 exit 0、隐藏验收 1/1。
- `parallel`：`waves=[[st-1,st-2],[st-3]]`、波次一区间重叠、三次 applied、`st-3` worktree 可见依赖实现、隐藏验收 3/3、验收三条均 exit 0。
- 两个演示均断言用户工作树 `HEAD` 与 `status --porcelain` 不变。

**未包含**

- 真实模型版本（需单独授权后再录制）；冲突演示（M3 的崩溃演示与 e2e 已覆盖冲突处置）。

## M4-① 组合夹具与验收器（2026-11-08）

**改动**

- 新增 `test/fixtures/orchestration/`：`parallel-composite`（normalize + dedupe 并行，report 依赖前两者进入第二波次）与 `single-repair`（复用 repair 的单根因任务）。
- 组合夹具的材料化、计划生成、隐藏验收器执行与正反例校验集中在 `scripts/orchestration-fixtures.ts`；`report` 的参考解与隐藏验收器为本步新增。
- 两套验收的分工与理由见 [DECISIONS.md](DECISIONS.md) 的 M4-①：计划验收命令只跑工作区内冒烟检查，隐藏验收器在整合结果上独立运行并作为最终结论。

**验证**

```text
pnpm typecheck                 # 通过
pnpm build                     # 通过
pnpm lint                      # 289 files, no warnings
node --test dist/test/orchestration-fixtures.test.js
# tests 4 / pass 4 / fail 0
```

**测试覆盖**

- 两份夹具的初始态均被隐藏验收器拒绝，参考态全部通过。
- `parallel-composite` 计划分层为 `[[st-1, st-2], [st-3]]`、判定 `parallel`；隐藏验收器位于工作区之外，工作区不含 `report` 的实现。
- `single-repair` 判定 `single`，保留项目规则与公开检查，初始态隐藏验收失败。
- 所有计划验收命令均为工作区内相对路径（宿主在整合 worktree 中运行）。

**未包含**

- 演示脚本与评测执行器（M4-②/③）；真实模型批次需要单独授权（M4 付费边界）。

## M3-⑤ 崩溃演示（2026-11-07）

**改动**

- 新增 `scripts/demo-orchestrate-crash.ts` 与 `pnpm demo:orchestrate-crash`：临时 git 仓库 + 脚本模型，不配置 provider、不发起付费请求。
- 演示序列：两个并行子任务中 st-1 完成、st-2 先执行 Bash 后停在未返回的 provider 调用；`after-worker-run` 注入崩溃。随后不带确认的 `resume` 因崩溃未知用量停在 `needs_human`；带 `--accept-unknown-usage` 后采用 st-1、为 st-2 生成 `unknown_side_effects`；带 `--retry st-2` 完成第二 epoch、整合与验收。
- 断言：崩溃前无 `root/finish`；st-1 采用时 provider 调用数不增加；最终 `completed`；用户工作树 HEAD/状态不变。

**验证**

```text
pnpm typecheck                 # 通过
pnpm check                     # syntax ok: 256 files
pnpm lint                      # 287 files, no warnings
pnpm demo:orchestrate-crash    # PASS；scripted provider requests=6；user worktree unchanged
pnpm test                      # tests 654 / pass 624 / fail 0 / 30 platform-skipped
```

**未包含**

- 演示只覆盖一个指定的崩溃点；§8.4 其余窗口由 `test/orchestration-recovery.test.ts` 覆盖。演示使用脚本模型与合成 usage，不代表模型能力或真实账单。

## M3-③ attempt 与整合恢复（2026-11-07）

**改动**

- 新增 `src/orchestration/faults.ts`：命名检查点抛出 `SimulatedCrash`，只在测试/演示注入；`integrator.applyAttempt` 与 `verifier` 接受故障钩子，可分别制造“cherry-pick 成功但未记 applied”与“验收已跑但未记证据”的窗口。
- 新增 `src/orchestration/recovery.ts`：
  - 只读解析 worker 会话的已确认前缀，判断 run 是否 completed、是否有 `status=unknown` 的工具结果或已开始未收尾的 Bash。
  - `recoverOpenIntegration`：中止残留 cherry-pick，回到 `integration/started` 记录的基线，按 `applied` 重放，再写 `integration/finished`。
  - `reconcileAttempts`：completed run 优先用带 trailer 的提交采用；否则从 worktree 收集提交；不可采用时记 `interrupted`；未知副作用生成 `unknown_side_effects` 人工请求，无未知副作用且未达上限时自动重试。已有人工决定（retry/abandon）优先，不重复询问。
  - `resolvePendingHumans` 把 `resume --retry/--skip` 映射为 `human/resolved`；`blockingUnknownUsage` 区分崩溃/无 usage 与取消。
- `resumeOrchestrate`：打开既有编排日志与账本；补做未记录的计划；未知用量未确认时停在 `needs_human`；恢复整合与 attempt 后从当前波次继续；只在同一 head/tree 上缺少证据时运行验收命令；已有 `root/finish` 时直接返回。
- CLI 增加 `orchestrate resume <rootId> [--accept-unknown-usage] [--retry]... [--skip]... [--plan] [审批选项]`；两级 Ctrl-C 同样适用；输出 pending 请求与建议命令。`root/start` 持久化 `verifyCommands`/`prepareCommand` 供恢复使用。
- 编排器在崩溃注入时 `markCrashed()` 再 abort 兄弟 worker；被中止的 sibling 记 `interrupted + unknownSideEffects`，日志关闭前等待全部 worker 收尾。

**验证**

```text
pnpm typecheck                 # 通过
pnpm build                     # 通过
node --test dist/test/orchestration-recovery.test.js dist/test/orchestration-e2e.test.js
# recovery 7 / pass 7；e2e 13 / pass 13（含 resume 参数解析）
```

**测试覆盖**

- `after-worker-run` 崩溃：resume 采用 completed run 的 worktree 改动，provider 调用数不变，只有一个 attempt/worktree，整合与验收完成。
- `after-cherry-pick` / `after-integration-started`：从记录基线重置并关闭旧整合，已成功 attempt 在新周期重新应用。
- `after-attempt-planned`：resume 原地启动既有 planned attempt，不新建 attempt/worktree。
- `after-verify-command`：无证据时重跑验收命令，只记录一条 exit 0 证据。
- 两个 worker 中一个崩溃、一个在途：在途调用记 `unknown(cause=crash)`；未确认时 `needs_human`；确认后中断 sibling 产生人工请求；`--retry st-2` 完成根任务，采用 st-1 不增加 provider 调用。
- 编排日志尾部半行：`resume` 明确拒绝且不改写日志，需按既有规则显式隔离。

**未包含**

- 真实进程崩溃（测试用故障注入模拟）；已开始的 Bash 在仓库外的影响仍需人工核实。
- 价格表与费用上限；`maxUsd` 仍只做配置校验。

## M3-④ 账本恢复与 429 冷却（2026-11-07）

**改动**

- `group/usage-unknown` 的 `cause` 进入根组状态：`cancel` 不中止组、不阻断后续派发；`crash`/`no_usage` 保持 M0 的保守规则。`acceptUnknownUsage()` 在人工确认后允许继续，未知量仍按预留额计入总量。
- `openJournal` 恢复时把 `reserved` 释放、`dispatched` 记为 `unknown(cause=crash)`；恢复流程可据此要求确认。
- 429：根组记录共享冷却 `max(retryAfterMs, 2s)`，下一次派发在准入后等待；被 429 明确拒绝的预留释放而不计费，Loop 的退避重试得以继续。编排器的进程内崩溃注入在 abort 兄弟 worker 前调用 `markCrashed()`，使被中止的在途调用按 crash 记账。
- `snapshot()` 增加 `blockingUnknown`、`acceptedUnknown`、`cooldownUntil`；`stopReason`/`#check` 只对未被确认的 blocking unknown 报错。

**验证**

```text
pnpm typecheck                 # 通过
pnpm build                     # 通过
node --test dist/test/orchestration-ledger.test.js dist/test/task-group-budget.test.js
# tests 16 / pass 16 / fail 0
```

**测试覆盖**

- `cancel` 未知后仍可预留；`crash` 未知拒绝继续，`acceptUnknownUsage()` 后恢复；折叠日志保留各自 cause。
- 429 释放预留（`requests=0`），冷却为 `max(retryAfterMs, 2s)`，下一次派发等待 2000 ms 后成功结算。

**未包含**

- 持久化冷却截止时间（进程内共享即可）；429 之外的 provider 错误仍按 M0 的未知规则处理。

## M3-② 两级停止语义（2026-11-07）

**改动**

- 新增 `StopController`：第一次 `dispatchSignal` 只写 `control/stop(dispatch)`，不再启动新 attempt；第二次 `signal` 或 wall 截止写 `control/stop(running)`、中止运行中 run，并在整合前退出。
- 编排器按日志而不是本地结果收集本波次的成功 attempt，使停止派发后仍能整合已完成部分并运行验收；停止运行中不打开整合、不复用旧验收证据。
- CLI `orchestrate run` 注册 SIGINT：第一次提示并停止派发，第二次中止运行中；退出时移除监听。
- `root/start` 增加可选的 `verifyCommands` 与 `prepareCommand`，为 M3-③ 的 `resume` 重建命令上下文。
- 并发池改为等待全部 worker 收尾后再抛出失败，崩溃时兄弟 worker 先收到中止，避免编排日志关闭后继续写入。

**验证**

```text
pnpm typecheck                 # 通过
pnpm build                     # 通过
node --test dist/test/orchestration-stop.test.js dist/test/orchestration-e2e.test.js
# stop tests 3 / pass 3；既有 e2e 13 项保持通过
```

**测试覆盖**

- 两子任务同波次、`maxWorkers=1`：第一次 Ctrl-C 在 st-1 运行时触发，st-1 完成并整合、st-2 记 `skipped`，验收 exit 0，根任务 `partial`，用户工作树不变。
- 第二次 Ctrl-C：st-1 记 `cancelled`，无整合、无验收，`control/stop(running)` 落盘，根任务 `cancelled` 并写 `root/finish`。
- 可控时钟越过 wall 截止：看门狗写 `control/stop(running)`、中止运行中 attempt，根任务 `cancelled`。

**未包含**

- 崩溃后的恢复与 `resume`（M3-③）；恢复窗口的失败注入。

## M3-① 状态折叠的迟到/过期/重复规则（2026-11-07）

**改动**

- `attempt/finished` 新增可选 `unknownSideEffects`：仅在 `interrupted` 结局上允许为真，表示会话中出现过 `status=unknown` 的工具结果或已开始但未收尾的 Bash。状态折叠把它保留到 `AttemptState`。
- `group/usage-unknown` 新增可选 `cause`（`crash`/`cancel`/`no_usage`），折叠后写入 `LedgerReservation.cause`；旧日志缺省按 `no_usage`。会话日志与编排日志的校验同时接受该可选字段。
- `attempt/late` 新增可选 `epoch`：只接受已终结 attempt，且 epoch 必须与对应 attempt 一致；迟到结果仍只记录、不改变状态或账本（I10）。

**验证**

```text
pnpm typecheck                 # 通过
pnpm build                     # 通过
node --test dist/test/orchestration-state.test.js dist/test/orchestration-ledger.test.js dist/test/task-group-budget.test.js
# tests 21 / pass 21 / fail 0
```

**测试覆盖**

- 中断 attempt 的 `unknownSideEffects` 与未知预留的 `cause=crash` 在折叠后仍可读；同 epoch 的迟到结果被接受且不改变状态，错误 epoch 被拒绝。

## M2-⑤ 多 attempt 整合与冲突处置（2026-11-07）

**改动**

- 冲突不再立即终止整合：`integration/conflict` 只记录冲突并把根任务置为 `needs_human`，整合周期保持开启；人工决定后继续应用同波次剩余 attempt，最后写 `integration/finished`。状态折叠允许带冲突记录的整合完成，并在 `human/resolved` 且无其他未决请求时恢复根状态。
- 编排器新增 `decide` 钩子与 `conflictOptions`：`rerun-serially` 以当前整合 head 为基线创建 epoch+1 的新 attempt（新 worktree/会话，受 `maxAttemptsPerSubtask` 限制），`skip-subtask` 保持该子任务未整合，`abort` 写 `control/stop` 并以 `cancelled` 收尾。无决定或无效决定时停在 `needs_human`，不写 `root/finish`。
- 最终验收只运行已整合子任务的验收命令与根级 `--verify`；被跳过的子任务不参与。根状态：全部子任务整合且验收通过为 `completed`；至少一个整合且验收通过为 `partial`；验收失败为 `failed`。
- CLI 在交互终端询问冲突处置；非交互运行保留 `needs_human` 现场并提示 `resume` 属 M3。`inspect` 显示每个波次的整合、applied/conflicts、计划来源与审批统计。

**验证**

```text
pnpm typecheck                 # 通过
pnpm build                     # 通过
node --test dist/test/orchestration-e2e.test.js dist/test/orchestration-worker.test.js
# tests 24 / pass 24 / fail 0（含既有 M1/M2-④ 用例）
```

**测试覆盖**

- 真实 git 的文件/目录冲突（`blocked` 文件与 `blocked/x.txt`；按写集定义两者不相交）：并行两个 worker 都成功，第二波次 cherry-pick 冲突并写 `human/requested(conflict)`；选择 `skip-subtask` 后整合完成、验收 exit 0、根任务 `partial`，用户工作树不变。
- 选择 `abort`：根任务 `cancelled`、`control/stop` 落盘、整合保持 `started` 供检查、没有验收证据。
- 无决定：根任务 `needs_human`、请求保持 pending、无 `root/finish`。
- 选择 `rerun-serially`：新建 epoch=2 的 attempt，baseCommit 等于当前整合 head；该重跑因目标路径不可写以 `no_changes` 结束，根任务仍为 `partial`（重跑失败不会伪造成整合）。
- `conflictOptions` 在 attempt 上限处移除串行重跑；`inspect` 文本可渲染多波次整合。

**未包含**

- 整合修复 attempt（核心扩展）；`resume` 与崩溃窗口（M3）。串行重跑在重跑仍失败时不会再次询问，根任务最多 `partial`/`failed`。

## M2-④ 并行波次调度（2026-11-07）

**改动**

- 重写 `src/orchestration/orchestrator.ts`：计划文件或只读 planner 二选一；按 `plan/decision` 的波次执行，`parallel` 模式用并发池（上限 `maxWorkers`），`single` 模式逐个执行；每个 attempt 独立 worktree/分支/会话；依赖子任务的 commit、changedFiles 与摘要进入 worker 的 `task.assign`；波次 attempt 以当前整合 head 为基线。
- `src/orchestration/integrator.ts` 拆出 `openIntegration`/`applyAttempt`/`finishIntegration`；`WorktreeManager.ensureIntegration` 跨波次复用同一整合分支（首次从基线创建，之后从既有 head 继续）。`git.ts` 增加 `worktreeCheckout`。
- 状态折叠保留 `integrations[]` 历史：每个波次一个整合周期，`completed` 判定使用全部周期的 applied 并集；最终验收只绑定最后一个周期的 tree。
- 波次预算 = `min(worker 上限, 根余额 ÷ 本波次待启动 attempt 数)`；依赖未整合的子任务写 `planned → finished(skipped)`，不启动 worker。
- `TaskGroupPolicy` 新增 `maxInFlightRequests`（0 = 不限制，保持会话委派既有行为）；根组设置为 `maxWorkers + 1`，准入时统计 `reserved` 与 `dispatched`，避免并发 dispatch 同时越界。
- CLI：`--plan` 改为可选，省略时由 planner 生成；审批提示标注 attempt 与写集。
- 冲突仍按 M1 行为停在 `needs_human`；三选一处置在 M2-⑤。

**验证**

```text
pnpm typecheck                 # 通过
pnpm build                     # 通过
node --test dist/test/orchestration-e2e.test.js dist/test/orchestration-ledger.test.js \
  dist/test/orchestration-state.test.js dist/test/orchestration-git.test.js
# pass：既有 14 项 + 并行/单模式/planner 端到端 3 项，全部通过
```

**测试覆盖**

- 三子任务组合计划（真实 git + 脚本模型）：两波次 `[[st-1, st-2], [st-3]]`；第一波两个 attempt 的 started/finished 时间区间重叠；第二波 worker 的 worktree 中能看到依赖产物；两次整合共应用 3 个 attempt；验收命令只在最终 tree 上运行一次且 exit 0；用户工作树 HEAD/内容/状态不变。
- `single` 模式按声明顺序逐个执行，区间不重叠。
- 省略 `--plan` 时 planner 会话被记录为 `plan.source=model` 且日志可被 `inspectSession` 完整读取。
- 根账本在途上限：`reserved` 与 `dispatched` 都占名额，结清后释放。
- 既有 M1 单 attempt、无改动、写集越界、预算停止、脏工作树、状态折叠与 git 测试全部保持通过。

**未包含**

- 冲突三选一（`rerun-serially`/`skip-subtask`/`abort`）与 `partial` 终态（M2-⑤）；`resume`（M3）；整合修复 attempt（核心扩展）。

## M2-③ 审批 FIFO 队列（2026-11-07）

**改动**

- 新增 `src/orchestration/approval-broker.ts`：单一 FIFO 队列、一次只显示一条；`write_file`/`edit_file` 按 `writes` 策略自动批准，Bash 按 `bash` 策略询问，未知工具一律询问；每条请求从**显示时**开始计时；`cancelAttempt` 立即拒绝该 attempt 的队列请求并中止正在显示的请求；`close` 拒绝全部剩余请求。
- 新增审计事件 `approval/requested`（requestId、attemptId、tool、summaryHash、writeSet）与 `approval/resolved`（allowed、source: auto/user/timeout/cancelled）；只追加、不参与恢复，审计写入失败不影响工具收到的决定。
- 编排器接入 broker：M1 单 attempt 路径改为统一走队列；worker 的 `approvalTimeoutMs = perRequestTimeoutMs × (maxWorkers + 1)`，避免在队列中等待时先触发 worker 自身的审批超时。
- `inspect` 增加审批统计（total/pending/auto/user/timeout/cancelled/denied）。

**验证**

```text
pnpm typecheck                 # 通过
pnpm build                     # 通过
node --test dist/test/orchestration-approval.test.js dist/test/orchestration-e2e.test.js
# tests 11 / pass 11 / fail 0
```

**测试覆盖**

- 三个并发 Bash 审批的显示顺序严格为 FIFO，峰值并发为 1；每个决定都对应一条审计。
- D8 策略：写入自动批准且不提示；Bash 提示；`writes: ask` 时编辑需人工且被拒绝时返回 false；未知工具默认询问。
- 显示超时（20 ms）返回 false 且审计来源为 `timeout`；取消 attempt 使活动与排队请求都返回 false；关闭通道把剩余请求标为 `cancelled`。
- M1 端到端行为不变：写入自动批准的审计事件进入编排日志，状态折叠与 `inspect` 正常。

**未包含**

- 终端显示（CLI 接线在 M2-④）；审批等待计入主动执行时间的口径仍由现有 run 预算维持。

## M2-② 只读 planner（2026-11-07）

**改动**

- `src/core/agent-capabilities.ts` 新增 `planner` 角色：与 `analyst` 同档位，使用 `READ_ONLY_TOOLS`，不注册 Bash、写工具、MCP 或委派。
- 新增 `src/orchestration/planner.ts`：在基线快照 worktree 上装配只读 Harness，会话目录为 `sessions/planner/<sessionId>`；计划 JSON 从最后一个代码块或整段文本解析，结构错误时在同一会话追加一次纠正消息；连续两次无效抛出带校验错误的异常。
- planner 的 `parentTaskGroup` 接入根账本；预算由调用方按 `plannerShare` 分配（编排器接线见 M2-④）。

**验证**

```text
pnpm typecheck                 # 通过
pnpm build                     # 通过
node --test dist/test/orchestration-planner.test.js dist/test/agent-capabilities.test.js
# tests 7 / pass 7 / fail 0
```

**测试覆盖**

- `planner` 与 `analyst`/`test_designer`/`reviewer` 一样只注册读工具，能力清单角色为 `planner`。
- 脚本模型首次返回非计划、第二次返回合法计划：计划被接受；会话日志由 `inspectSession` 完整读取，meta 记录 `rootId` 与 `planner: true`。
- 连续两次无效：以 `invalid plan twice` 失败；解析器接受围栏与裸 JSON，并拒绝错误版本。

**未包含**

- 编排入口在缺少 `--plan` 时调用 planner、`plannerShare` 的实际预算分配与 CLI 文案（M2-④）。

## M2-① 计划校验与判定（2026-11-07）

**改动**

- 新增 `src/orchestration/plan.ts`：计划结构校验（复用 `planInputError`）、写集重复与保护路径（`.git/`、`.mini-dsh/`、可配置项）、Kahn 拓扑分层与环检测、同波次写集两两相交检查（文件精确、目录前缀、Windows 大小写）、验收命令经 `SandboxRuntime.inspectCommand` 形状检查、`single`/`parallel` 判定与理由。
- 跨波次写集允许重叠：后一波次的 attempt 以整合 head 为基线，能看到前一波次的已整合结果。

**验证**

```text
pnpm typecheck                 # 通过
pnpm build                     # 通过
node --test dist/test/orchestration-plan.test.js
# tests 7 / pass 7 / fail 0
```

**测试覆盖**

- 三子任务 DAG 分层为 `[[st-1, st-2], [st-3]]` 并判定 `parallel`；依赖深度而非声明顺序决定波次。
- 环、同波次文件/目录前缀相交、重复写集条目、保护路径均被拒绝；跨波次重叠允许。
- 验收命令形状拒绝（注入闸门与真实 `SandboxRuntime`）；`auto`/`single`/`parallel` 判定与强制并行拒绝。
- `maxSubtasks` 与结构错误有界。

**未包含**

- planner、审批队列、波次调度与冲突处置（M2-②—⑤）。

## M1-④ 单 attempt 编排闭环与 CLI（2026-11-07）

**改动**

- 新增 `src/orchestration/worker.ts`：worker Harness 装配（独立 root/worktree/会话、`parentTaskGroup`、只读之外唯一的可写角色、无委派工具、显式 `autoApprove: false`）、`task.assign` 渲染、有界 worker 报告解析（8 KiB 正文 / 2 KiB 摘要）。
- 新增 `src/orchestration/integrator.ts`：写集覆盖判断（文件精确匹配、目录前缀、Windows 大小写）、宿主提交与 attempt trailer、worker 自行提交时软回基线后重新提交、按计划顺序 cherry-pick 与冲突中止。
- 新增 `src/orchestration/verifier.ts`：在整合 worktree 运行验收命令，日志落内容寻址制品，事件绑定整合 head/tree。
- 新增 `src/orchestration/orchestrator.ts`：根预算解析与 `TaskGroupBudgetCoordinator` 接入、单 attempt 调度、失败分类、整合、复验、报告与 `root/finish`。
- 新增 `src/orchestration/inspect.ts` 与 `src/app/orchestrate-cli.ts`；`src/index.ts` 增加 `orchestrate` 子命令（run/inspect/list/cleanup）；更新 `--help`。
- D8 落地为编排入口的审批函数：文件写入默认自动、Bash 默认询问，`--approve-writes ask` / `--approve-bash auto` 可调；单 Agent CLI 未改。

**验证**

```text
pnpm typecheck                 # 通过
pnpm build                     # 通过
node --test dist/test/orchestration-e2e.test.js dist/test/orchestration-worker.test.js dist/test/orchestration-integrator.test.js
# tests 11 / pass 11 / fail 0
```

**测试覆盖**

- 离线端到端（脚本模型 + 真实 git）：worker 在 worktree 写入、宿主提交（带 trailer）、cherry-pick 整合、验收 exit 0、`root/finish(completed)`；用户工作树 HEAD/内容/状态不变；worker 会话日志由现有 `inspectSession` 完整读取（`integrity.complete`）。
- `no_changes`、写集越界、根预算在第二次 provider 请求前停止、脏工作树在创建任何编排状态前拒绝。
- worker 报告无效/超长/`needs_input`；写集文件与目录前缀；CLI 参数接受与拒绝。
- worker 绕过提示自行提交时，宿主软回基线并生成单一带 trailer 提交。

**未包含**

- 并行波次、planner、审批队列、冲突处置（M2）；`resume`、崩溃窗口与 unknown 用量确认（M3）；演示与评测（M4）。
- `plannerShare`、`fixReserveTokens`、`maxInFlightRequests` 已进入配置与契约，但 M1 尚未执行对应准入逻辑（随 planner/修复/并发上限在 M2/M4 落地）。

## M1-③ git 与 worktree 管理（2026-11-07）

**改动**

- 新增 `src/orchestration/git.ts`：有界 git 调用（超时、输出上限、错误形状）；仓库根、HEAD/tree、porcelain 状态、worktree 增删与列举、暂存、按基线列出改动、宿主提交（`-c` 临时身份、`--no-verify`、attempt trailer）、按 trailer 查提交、cherry-pick 与冲突状态/中止、分支列举与命名空间内删除。
- 新增 `src/orchestration/worktrees.ts`：目录布局、`mini-dsh/<root8>/<subtask>-<epoch>` 与整合分支命名、脏工作树拒绝/`--allow-dirty`、base 快照、attempt/整合 worktree、prepare 命令（10 分钟默认超时）、只清理本根任务 worktree 与命名空间分支。
- cherry-pick 与宿主提交使用同一临时身份：临时 HOME 下没有用户 `user.email`，否则整合提交会失败。

**验证**

```text
pnpm typecheck                 # 通过
pnpm build                     # 通过
node --test dist/test/orchestration-git.test.js
# tests 3 / pass 3 / fail 0
```

**测试覆盖**

- 仓库识别、tree SHA、干净/脏状态与 `--allow-dirty`。
- base 快照 detached；attempt worktree 与分支；重复分支拒绝；暂存后按基线列出改动；宿主提交与 trailer 查询。
- cherry-pick 成功、冲突检测与中止回到整合 head；清理后 worktree/分支消失，用户工作树内容与状态不变。
- prepare 在 worktree 内运行；失败命令带 stderr 阻止该 attempt。

**未包含**

- worker 执行、宿主整合编排与 CLI（M1-④）；冲突的人工处置与串行重跑（M2）。

## M1-② 编排存储、状态折叠与根账本日志（2026-11-07）

**改动**

- 新增 `src/orchestration/contracts.ts`：根任务、计划、attempt、整合、验收、人工请求与 `group/*` 预算事件的日志信封。
- 新增 `src/orchestration/validation.ts`：事件信封/负载运行时校验、计划结构校验、日志解码；未知类型与未知版本拒绝。
- 新增 `src/orchestration/store.ts`：`OrchestrationStore`（`writer.lock`、逐条 fsync、`seq` 严格递增、尾部半行拒绝与 `quarantineTail`）。
- 新增 `src/orchestration/state.ts`：`foldOrchestration` 纯函数、合法迁移检查、根任务终态约束、按来源统计的账目。
- 新增 `src/orchestration/group-journal.ts`：`OrchestrationGroupJournal` 把 M0 协调器的 `group/*` 事件写入编排日志。
- 新增 `docs/superagent/{REQUIREMENTS,DECISIONS,TASKS,CHANGES}.md`，记录 D8 审批策略与本里程碑实现决策。

**验证**

```text
pnpm typecheck                 # 通过
pnpm build                     # 通过
node --test dist/test/orchestration-store.test.js dist/test/orchestration-state.test.js dist/test/orchestration-ledger.test.js
# tests 14 / pass 14 / fail 0
```

**测试覆盖**

- 存储：落盘与重开续号、第二个写入者被拒、非法负载不落盘且不封存、并发追加序号唯一、半行拒绝与显式隔离。
- 状态：完整单 attempt 生命周期、非法迁移、迟到结果、`group/*` 账目与来源统计、`completed`/`partial` 终态约束、混合根任务与未知事件。
- 账本：预留-派发-结算写入编排日志、重开时释放未派发预留并把已派发转未知、并发准入不超额、注入时钟的 wall 截止。

**未包含**

- 审批队列（M2）；未来日志版本的只读兼容（M3）；git/worktree 与 worker 执行（M1-③/④）。
