# 多 Agent 编排改动与证据

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
