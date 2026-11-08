# 多 Agent 编排实现决策

**非规范性说明：** 方向性决策与数值以 [DEVELOPMENT.md](DEVELOPMENT.md) §2.8 为准；本文件记录开发过程中落实这些决策的具体选择、代码锚点与测试锚点，避免把实现事实只留在提交信息里。

## v0.3.0 发布（2026-11-08）

- **决定：** 编排合入 main 后按次版本号发布 v0.3.0：新增 `orchestrate` 子命令与可选只读委派，默认行为（单 Agent、委派关闭）与 v0.2.0 相同。修订上一节“是否发 v0.3.0 由后续任务决定”。
- **决定：** CI 的仓库外安装 job 增加两项检查：tarball 安装后的 `--help` 含 `orchestrate run`、`orchestrate list` 无状态时输出 `no orchestrations`。证明编排随包发布，而不是只在源码里可用。
- **决定：** 文档护栏扩到“尚未发版”：`package.json` 版本 ≥ 0.3.0 且源码含 `orchestrate` 时，用户文档中提到编排的行不得再写“尚未发版 / Release 不含 / 需从源码运行”。主语识别包括“编排”、`orchestrate` 与里程碑区间（M1–M4），因为初版只认“编排”而漏掉了两行。
- **代码锚点：** 无运行时代码改动；`package.json`、`.github/workflows/ci.yml`。
- **测试锚点：** `test/progress-sync.test.ts` 的“package.json 版本已含编排时，用户文档不再写编排尚未发版”。

## 合入 main 后的文档口径（2026-11-08）

- **决定：** M0—M4 的分支链按里程碑分别以 PR #26—#30 合入 main，用 merge commit 保留各步骤的原始提交，不 squash/rebase（[AGENTS.md](../../AGENTS.md) 的提交边界规则）。
- **决定：** 合入后 README、PROGRESS、USAGE、讲解提纲与 REQUIREMENTS 改写为“已在 main、尚未发版”；v0.2.0 Release 不含编排，是否发 v0.3.0 由后续任务决定（已由上一节的 v0.3.0 发布修订）。修订 M4-④ 中“开发分支，待评审合并”的口径。
- **决定：** 用回归测试挡住这类漂移：`src/app/orchestrate-cli.ts` 存在时，上述五份用户文档里提到编排的行不得再写“尚未合入/待评审合并/main 尚未包含入口”等。测试以源码事实为条件，入口被移除时自动失效，而不是永久黑名单。
- **代码锚点：** 无运行时代码改动。
- **测试锚点：** `test/progress-sync.test.ts` 的“orchestrate 子命令已在源码中时，用户文档不再写编排未合入 main”。

## M4-④ 里程碑收尾与文档口径

- **决定：** M4 以**离线部分完成**收口；付费小批次保持未执行，文档只写「需单独授权、尚无结果」，不预留结果数字或占位结论。
- **决定：** README 把编排能力放在“开发分支，待评审合并”下，并明确 main 尚未包含入口；不把分支能力描述成 main 已交付。（合入 main 后由上一节修订。）
- **决定：** 证据只引用本步实际命令输出（`pnpm check`、`pnpm test`、`pnpm lint`、三个演示与 `eval:orchestrate --validate-only`），不复用 M1–M3 的历史数字；`test` 的 platform-skipped 仍按平台条件计入而非声称本机通过。
- **代码锚点：** 无运行时代码改动；文档与证据在 `docs/superagent/`、`README.md`、`PROGRESS.md`。
- **测试锚点：** M4-④ 的验证命令与结果见 [CHANGES.md](CHANGES.md)。

## M4-③ 离线评测执行器

- **决定：** 本步只实现**离线装配与零付费校验**。`eval-orchestrate` 只接受 `--validate-only`；`--execute` 被显式拒绝并提示按 §14.4 对该次批次单独授权。理由：付费批次需要授权、模型回显探测与按价格表计算的上限，且结果必须另成证据提交；把它们塞进离线校验脚本会制造「跑个校验就付费」的通道。
- **决定：** 四臂是**数据装配**而不是已接线的执行器：S（单 Agent）、D（`delegation.mode=read-only`）、R（完整编排，`maxWorkers=2`）、R-serial（同一计划，`maxWorkers=1`）。D′（关闭治理）与 §14.3 的“冲突型”“负对照”任务类别明确列为未装配，不假装覆盖；它们的预注册随授权批次一起提交。
- **决定：** 公平性由 `validateRunMatrix` 机械检查：同一任务的目标、整题预算与隐藏验收器在四臂间逐字相同；R 与 R-serial 只差 `maxWorkers` 且共享同一计划；S 与 D 只差 `delegation` 且都不接收编排计划；四臂与重复次数齐全。任一被改动即整体失败。
- **决定：** 零 provider 请求由哨兵适配器见证：装配阶段放入 spec 的 `chat` 一旦被调用就计数并抛错；`validateOfflineBatch` 结束时要求计数为 0。夹具正反例与隐藏验收器都只读写本地文件。
- **代码锚点：** `scripts/eval-orchestrate.ts`、`package.json` 的 `eval:orchestrate`。
- **测试锚点：** `test/eval-orchestrate.test.ts`（矩阵完整性/公平性、篡改检测、零付费、正反例、参数守卫、哨兵）。

## M4-② 单/并行演示

- **决定：** 两个演示都走真实入口：只读 planner 用脚本模型生成计划（`plan.source=model`），worker 与宿主整合/复验走正常路径；演示只在模型侧用脚本，不伪造 plan 事件或验收证据。
- **决定：** 演示的**最终验收结论来自工作区之外的隐藏验收器**；宿主计划里的冒烟检查只证明整合后命令可复跑。二者都通过才打印 PASS。这与 M4-① 的两套验收分工一致。
- **决定：** 并行演示的并行性用编排日志里 `attempt/started` 与 `attempt/finished` 的 `at` 断言，第一波两个脚本 worker 各有 200 ms 延迟以保证区间重叠；第二波依赖用 **st-3 worktree 的实际文件内容**断言（归一化实现与去重实现已整合），不采信提示词里「dependencies」文案。
- **决定：** 演示不提供保留临时目录/跳过断言之类的隐藏开关；失败时仍清理临时目录，现场由编排日志与 CHANGES 的命令输出承担。需要复查时用 `orchestrate inspect`/`loadOrchestration` 的既有入口。
- **代码锚点：** `scripts/demo-orchestrate.ts`、`package.json` 的 `demo:orchestrate-single` / `demo:orchestrate-parallel`。
- **测试锚点：** 两个 `pnpm demo:*` 命令（脚本内断言 completed、波次、区间重叠、依赖可见、隐藏验收、用户工作树不变）。

## M4-① 组合夹具与验收器

- **决定：** 组合夹具把既有 coding fixture 的参考解与验收器搬到 `packages/<id>`；`parallel-composite` 的三个写集互不相交，`st-3` 依赖前两者因而进入第二波次。`single-repair` 复用 `repair` 的项目规则与公开 `check.mjs`，只用于 single 判定与 planner 开销演示。
- **决定（与 §14.3 的一处落差不藏）：** 计划验收命令**不能**引用工作区之外的隐藏验收器：宿主命令闸门拒绝绝对路径和 `..` 越界（`SandboxRuntime.inspectCommand` 的既有规则），而验收命令是普通字符串，没有额外的 trusted-command 通道。因此夹具分两套验收——
  - `check.mjs`（工作区内，冒烟）：计划里的 `acceptance.commands` 只跑每个包一个例子，作用是让宿主的整合后复验有可机械复跑的形状检查；
  - `verify.mjs` / `verify/report.mjs`（工作区之外，隐藏）：演示、离线评测与夹具门禁在整合结果上独立运行，**以它的读数作为最终验收结论**。隐藏验收器不进入 plan、编排日志或 worker 提示，worker 无从读取。
  这避免了「把隐藏判据塞进验收命令、等于公开给 worker」和「完全去掉宿主复验」两种极端。
- **代码锚点：** `scripts/orchestration-fixtures.ts`、`test/fixtures/orchestration/`。
- **测试锚点：** `test/orchestration-fixtures.test.ts`（初始态拒收、参考态通过、两波次分层、验收命令相对路径、隐藏验收器不在工作区）。

## M3-③ 恢复与 resume

- **决定：** 恢复只采用**已确认的结果**：worker 会话 run 为 completed 时，优先找 attempt 分支上带 `Mini-DSH-Attempt` trailer 的提交；没有提交则从 worktree 用宿主身份重新收集并提交。两条路径都不调用 provider，恢复前后 provider 调用数不变。未完成的 run 一律记 `interrupted`，不自动重跑。
- **决定：** 未知副作用只在会话证据支持时成立：存在 `tool/result(status=unknown)`，或 Bash 已 `tool/start` 而无对应结果。没有会话文件但 attempt 已 running 时保守按未知处理。未知副作用的 interrupted attempt 生成 `unknown_side_effects`，选项 `retry`/`abandon`；没有未知副作用的 interrupted attempt 在 attempt 上限内自动重试。
- **决定：** 整合恢复采用“重置+重放”而不是信任残留 cherry-pick：`cherry-pick --abort`（若有）、`reset --hard` 到 `integration/started` 的基线、按 `integration/applied` 顺序重放，然后补写 `integration/finished`。未记录的 attempt 由正常波次逻辑在新整合周期重新应用。
- **决定：** 验收证据按 `(head, tree, command)` 去重：恢复时只运行当前整合 tree 上缺失的命令；已有证据（包括失败）直接复用。tree 改变后旧证据不匹配，自然重新运行。
- **决定：** `resume --retry <subtask>` / `--skip <subtask>` 同时是人工决定入口：优先把对应的 pending `unknown_side_effects` 解析为 `retry`/`abandon`，把 `conflict` 解析为 `rerun-serially`/`skip-subtask`；仍有未决请求时停在 `needs_human`，不写 `root/finish`。`--accept-unknown-usage` 只解除账本准入，不替用户决定 attempt 的副作用。
- **决定：** 编排日志尾部半行继续由操作者显式隔离（`OrchestrationStore.quarantineTail`）；`resume` 明确拒绝且不改写日志。恢复使用日志中持久化的 budget/config/verify/prepare，不重新解释 `MINI_DSH_ROOT_BUDGET`。
- **代码锚点：** `src/orchestration/{faults,recovery,orchestrator}.ts`、`src/app/orchestrate-cli.ts`。
- **测试锚点：** `test/orchestration-recovery.test.ts`、`test/orchestration-e2e.test.ts`。

## M3-④ 未知用量与 429

- **决定：** `group/usage-unknown` 保留 `cause`。取消产生的未知只会计入报告，不中止根组也不阻断后续派发；`crash`/`no_usage` 继续沿用 M0 的保守规则，恢复时必须经 `acceptUnknownUsage()` 明确确认。确认只改变准入，不改变已记录的用量。
- **决定：** provider 明确以 429 拒绝时释放预留而不按未知计费，并设置根组共享冷却 `max(retryAfterMs, 2s)`；下一次派发（包括 Loop 的退避重试）在准入后等待冷却。这样既不让一次限流永久毒化账本，也不让多个 worker 同时撞限流。
- **决定：** 进程内模拟崩溃与用户取消都可能表现为 abort。编排器在 abort 前调用 `markCrashed()`，让被中止的在途调用按 `cause=crash` 记账；这是测试/演示的故障注入路径，正常取消不会调用。
- **代码锚点：** `src/core/task-group-budget.ts`（`acceptUnknownUsage`、`markCrashed`、`noteRateLimit`、`#waitCooldown`）、`src/orchestration/orchestrator.ts`。
- **测试锚点：** `test/orchestration-ledger.test.ts`、`test/task-group-budget.test.ts`。

## M3-② 停止语义

- **决定：** `dispatchSignal`（第一次 Ctrl-C）只停止派发：当前已在运行的 attempt 继续到自然结束，队列中未启动的 attempt 记 `skipped`；随后按正常路径整合已完成部分并验收，根任务为 `completed`/`partial`，没有整合则为 `failed`。
- **决定：** `signal`（第二次 Ctrl-C）与 wall 截止走同一条“停止运行中”路径：写 `control/stop(running)`、中止全部运行中 run、不打开整合、根任务 `cancelled` 并写 `root/finish`。wall 截止由 50 ms 看门狗检查注入时钟，保证可控时钟测试能打断运行中的 worker；账本自身的 wall 检查仍只在准入时生效。
- **决定：** 并发池等待全部 runner 收尾后再抛出失败（`Promise.allSettled`）。进程内模拟崩溃时先中止兄弟 worker，再让编排器关闭日志；真实进程崩溃不需要该步骤，但离线测试需要避免写入已关闭的日志。
- **决定：** `root/start` 记录 `verifyCommands` 与 `prepareCommand`，`resume` 不再依赖调用者重复提供；旧日志缺省为空。
- **代码锚点：** `src/orchestration/orchestrator.ts` 的 `StopController`、`src/app/orchestrate-cli.ts`、`src/orchestration/contracts.ts`。
- **测试锚点：** `test/orchestration-stop.test.ts`。

## D8 编排模式的审批策略（用户已确认，2026-11-06）

- **决定：** `orchestrate` 模式下，worktree 内的 `write_file` / `edit_file` 默认自动批准；Bash 默认仍需人工批准，所有请求经单一 FIFO 队列逐条显示；`--approve-writes ask` 可恢复逐条审批。单 Agent CLI 的审批行为不变。
- **理由：** worktree 内写入不触及用户工作树、可整体丢弃，且 attempt 结束后仍有写集检查；Bash 可越出 worktree，不能自动批准。
- **M2-③ 实现：** `ApprovalBroker` 为单一 FIFO 队列，`write_file`/`edit_file` 与 Bash 各按策略决定是否进入队列；未知工具一律询问。每条请求的超时从显示时开始；`cancelAttempt` 立即拒绝该 attempt 的队列请求并中止正在显示的请求；`close` 拒绝全部剩余请求。审批等待不计入主动执行时间仍由现有 run 预算维持；worker 的 `approvalTimeoutMs` 放大为 `perRequestTimeoutMs × (maxWorkers + 1)`。
- **审计口径：** `approval/requested` / `approval/resolved` 只用于统计与展示，写入失败被吞掉，绝不阻塞工具收到的决定；来源分为 `auto`/`user`/`timeout`/`cancelled`。
- **代码锚点：** `src/orchestration/approval-broker.ts`、`src/orchestration/orchestrator.ts`、`src/orchestration/worker.ts` 的 `autoApprove: false` 与 `sandbox.setApprover`。
- **测试锚点：** `test/orchestration-approval.test.ts`、`test/orchestration-e2e.test.ts`。
- **状态：** 已实现（M2-③）；CLI 终端显示随 M2-④ 接线。

## M2-⑤ 冲突处置

- **决定：** 冲突时 `git cherry-pick --abort` 回到整合 head，记录 `integration/conflict`，等待 `decide` 返回 `rerun-serially`/`skip-subtask`/`abort`。整合周期保持开启，人工决定后继续应用同波次剩余 attempt，最后统一 `integration/finished`；因此 `integration/finished` 允许保留历史冲突记录，`integration/conflict` 不再把整合状态改成 `blocked`。
- **决定：** `skip-subtask` 只把该子任务留在未整合集合，最终验收不运行它的验收命令；根任务最多 `partial`。`abort` 写 `control/stop(scope=running)` 并以 `cancelled` 收尾，不写 `integration/finished`，保留 worktree/分支供检查。
- **决定：** `rerun-serially` 以当前整合 head 为基线创建 epoch+1 的新 attempt（新 worktree、新会话，受 `maxAttemptsPerSubtask` 约束）；成功则在同一整合周期继续 cherry-pick，失败则不整合、继续处理其余 attempt。重跑再次冲突时重新询问，达到 attempt 上限后选项只保留 `skip-subtask`/`abort`。
- **决定：** 没有 `decide` 或返回无效值时，根任务停在 `needs_human`，不写 `root/finish`；非交互 CLI 因此保留现场，恢复入口在 M3。
- **代码锚点：** `src/orchestration/orchestrator.ts`、`src/orchestration/state.ts`、`src/app/orchestrate-cli.ts`。
- **测试锚点：** `test/orchestration-e2e.test.ts`、`test/orchestration-worker.test.ts`。

## M2-④ 并行波次与多波次整合

- **决定：** 一个根任务只有一个整合分支/worktree；每个波次写一组 `integration/started`/`applied`/`finished`，后续波次从既有整合 head 继续。状态折叠保留 `integrations[]` 历史，`completed` 用全部周期的 applied 并集判断，最终验收只绑定最后一个整合周期的 tree。
- **决定：** `plan/decision` 判定为 `single` 时，按计划顺序逐个子任务执行（并发 1），**不把多个子任务合并成一个 worker**。DEVELOPMENT.md §4.4(6) 的合并写法会破坏 attempt 与 subtask 的一一对应，以及 `completed` 要求每个子任务都有自己的 succeeded attempt 且已整合的不变量；串行执行同样满足“一次只运行一个 worker”的观察结果。该偏差记录在此，若后续要支持合并需要修改事件契约。
- **决定：** 波次预算按根余额 ÷ 本波次待启动 attempt 数切分，并受 `DEFAULT_WORKER_BUDGET`/`--worker-budget` 上限约束；根账本仍是外层硬约束。依赖未整合的子任务记录 `planned → finished(skipped)`，不创建 worktree。
- **决定：** 在途上限计入 `reserved` 与 `dispatched` 两种状态；预留到派发之间的窗口也占名额，否则两个并发 `dispatch` 会先后读到同一余额。会话委派的默认值为 0（不限制），只有编排根组启用。
- **决定：** planner 预算为 `maxTotalTokens × plannerShare`（默认 10%），最多 16 次请求；planner 在 worker 波次开始前结束，不与 worker 并发。planner 的纠正重试仍走同一个根账本。
- **决定：** 依赖子任务的基线是当前整合 head；`task.assign` 携带依赖的 commit、changedFiles 与宿主记录的报告摘要。wave worker 因此能看到前一波次的已整合结果。
- **代码锚点：** `src/orchestration/{orchestrator,planner,integrator,worktrees,git,state}.ts`、`src/core/task-group-budget.ts`。
- **测试锚点：** `test/orchestration-e2e.test.ts`、`test/orchestration-ledger.test.ts`、`test/orchestration-state.test.ts`。

## M1-④ 单 attempt 编排与 CLI

- **决定：** M1 的 `orchestrate run` 只接受计划文件且一次只执行一个子任务；planner、DAG 波次与并行写入者按里程碑留在 M2。CLI 在缺少 `--plan` 时明确拒绝，不伪装成已支持模型规划。
- **决定：** 审批策略在编排入口实现为 `writes: auto|ask`、`bash: ask|auto` 的函数；M1 不建 FIFO 队列（M2 落地 `ApprovalBroker`）。未提供审批通道时，需要人工的请求一律拒绝。
- **决定：** 若 worker 违反提示自行提交，宿主在 attempt worktree 内 `git reset --soft <baseCommit>` 后重新提交；整合对象始终是单一带 `Mini-DSH-*` trailer 的宿主提交，避免恢复依赖 worker 的提交习惯。
- **决定：** `plannerShare`、`fixReserveTokens`、`maxInFlightRequests` 先进入配置与事件契约，M1 不执行对应准入；在实现 planner、整合修复与并发上限时接入，并在本文件更新锚点。
- **代码锚点：** `src/orchestration/{worker,integrator,verifier,orchestrator,inspect}.ts`、`src/app/orchestrate-cli.ts`、`src/index.ts`。
- **测试锚点：** `test/orchestration-e2e.test.ts`、`test/orchestration-worker.test.ts`、`test/orchestration-integrator.test.ts`。

## M1-③ git 与 worktree

- **决定：** 所有宿主 git 调用经 `runGit`，统一 30 秒默认超时与 4 MiB 输出上限；提交与 cherry-pick 都用 `-c user.name=mini-dsh -c user.email=mini-dsh@localhost` 临时身份。原因是 `runCommand` 使用临时 HOME，用户全局 git 身份不可见；不修改任何 git 配置文件。
- **决定：** 清理只删除编排目录 `worktrees/` 前缀下的 worktree 与 `mini-dsh/<root8>/*` 分支；分支删除前再次校验命名空间，避免误删用户分支。
- **代码锚点：** `src/orchestration/git.ts`、`src/orchestration/worktrees.ts`。
- **测试锚点：** `test/orchestration-git.test.ts`（真实 git 临时仓库）。

## M1-② 编排日志与根账本落点

- **决定：** 编排日志使用独立目录与独立信封 `{v, rootId, seq, id, at, type, data}`；`src/core/` 不新增编排逻辑，`EventData` 会话契约不变。
- **决定：** 根预算组复用 M0 的 `TaskGroupBudgetCoordinator`，通过 `GroupJournal` 写入编排日志；不新建第二套预留/结算状态机。
- **决定：** 状态折叠 `foldOrchestration` 是纯函数，遇到非法迁移即拒绝；`completed` 根任务必须已整合全部子任务且验收证据全部通过，`partial` 必须已有整合且已整合部分验收通过。
- **决定：** 编排日志当前严格只读 `v: 1`；未来版本只读兼容与 `resume` 拒绝规则留到 M3 恢复流程实现，不提前宣称支持。
- **决定：** `approval/requested` / `approval/resolved` 审计事件随 M2 审批队列一起追加；事件类型只追加，不修改已有类型。
- **代码锚点：** `src/orchestration/contracts.ts`、`validation.ts`、`store.ts`、`state.ts`、`group-journal.ts`。
- **测试锚点：** `test/orchestration-store.test.ts`、`test/orchestration-state.test.ts`、`test/orchestration-ledger.test.ts`。
