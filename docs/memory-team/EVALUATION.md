# 记忆与协作的独立开发协议

本专题与 PR #6 的 full/no-preview/no-projection/no-report 四臂及其 48 条消融分开。原负结果、指标口径和 `postCompactionPrune` 默认关闭保持其原有结论。

协议 `memory-team-development-v2.1` 是开发准备批次：single-memory-off / single-memory-on / team-memory-off / team-memory-on，4 个工作流 × 4 条件 = 16 个目标 episode。它们是公开开发工作流，不是正式 holdout；开发观察不能追溯变为正式证据。

## 固定的批次输入

- 模型：请求名 `deepseek/deepseek-v4-flash`，服务端回显 `deepseek-flash`，版本 `DeepSeek-V4.1-Flash-1017`，1,000,000 token 窗口，provider 默认采样。付费前再次做直接与流式探测，回显不符即停。
- 价格：官方价格页 2026-10-27 快照，币种 USD，按高峰档 `input $0.30 / cache-read $0.006 / output $1.20` 每百万 token 计上限。峰谷价差只会让实际账单更低，上限按高峰价算。
- 任务：`docs/memory-team/eval/workflows.json` 的 W01—W04。每项都有公开交付物 `answer.json` 的精确 schema，但提示只给字段、不在提示里给出期望值；W02 还要求把 `docs/ENTRY.md` 改成当前入口，工作区用 `package.json` 的 `main` 给出权威当前入口，历史文档与记忆仍指向旧入口。
- 共同预算：prepare + goal + 所有子 Agent + 摘要 + 重试共用一个 episode 账本：32 次模型请求、64 次工具调用、320,000 token、900 秒 wall deadline；单 run 仍受 600 秒主动时长约束。root floor 为 120,000 token / 10 请求，子 Agent 不能耗尽交付额度。32 次请求给两个 8 请求子 Agent 留出空间，避免团队臂在展示协作开销前先撞公共上限。
- 金额：每 episode 上限 $0.50（覆盖 320k token 全按 output 计价的极端情形仍只需约 $0.384），整批上限 $8.50（16 × $0.50 + $0.05 探测，另留 $0.45 余量）。执行时 `--max-usd` 不得超过冻结值。
- 数据：四条件读同一份 `.memory-team/preparation.json`；memory-on 另外拥有一份预先批准、只读、从同一经验包生成的记忆快照。目标阶段不批准或抽取新记忆。

## 四个客观工作流

| 工作流 | 类别 | 独立验收 |
| --- | --- | --- |
| W01 | 知识复用 | `answer.json` 精确给出验证入口、验证命令和模块路径；受保护文件不变 |
| W02 | 旧知识失效 | `docs/ENTRY.md` 精确改为新入口；`answer.json` 判历史记忆不再适用；受保护文件不变 |
| W03 | 并行调查 | 两个模块路径齐全；parse/format 各有一个非空边界案例；`testsRan=false`；源码不变 |
| W04 | 负对照 | NaN 被判为接受；最小检查必须来自允许集合；历史尝试判为无帮助；源码不变；另行报告是否发生不必要委派 |

验收器 `scripts/memory-team-verifier.ts` 不参与执行：候选 Harness 完全退出后，执行器把工作区复制到 `acceptance-copy/`，验收器只读复制件，检查 `answer.json`、目标文件、受保护文件和未声明的额外文件。零付费验证还会同时断言两件事：未改动的初始工作区必须被拒收，人工构造的正确交付必须通过。

## 准备 → 目标两阶段

每个 episode 在同一个 session 内跑两个 root task：

1. **准备**：读取公开准备数据和项目文件，写 `PREPARE.md`；四条件使用同一提示和同一公开数据。
2. **目标**：下发工作流目标，产出 `answer.json`（W02 同时改 `docs/ENTRY.md`）。

两阶段各有独立的 run 计数，但共用一个 adapter 级 episode 守卫：每次 provider 调用前检查累计请求数、估算输入 + 输出上限、已花费美元和 wall deadline；provider 缺少可信 usage 立即阻止后续派发。组账本继续约束 root/child/summary/retry 的单 run 额度，因此子 Agent 不会因为并行而获得额外预算。准备或目标的成本分别落盘，不以合并总数掩盖。

## 必须报告的消耗

- 可靠完成与独立验收、基础设施失败、未知 usage、预算停止。
- prepare / goal 分别的请求、工具、provider token、成本；完整 episode 成本包括记忆处理、所有子 Agent、摘要、重试与汇总。
- root / summary / child 三类账目；每类请求数、token、成本、未知请求。
- 重试次数、失败尝试的 token 与成本。
- 记忆查询次数、命中条数、过滤原因（过期、撤销、锚点变化等）与 view 事件数。
- 委派批次数、子会话数、子结果状态与字节数；W04 是否发生不必要委派。
- makespan（用户等待）与所有 Agent 主动时间之和分开报告；后者不能当作等待时间。
- 逐题配对的收益（可靠完成/验收差值）与额外开销（token、成本、请求、wall、子 Agent、摘要、重试、记忆）。

16 个开发 episode 是探索性规模，不作显著性、泛化或“默认开启”结论。

## v2 开发观察（2026-10-27，仅作设计输入）

v2（提示内嵌期望答案）已执行 16/16：15 条独立验收通过，估算 $0.469586，1,437,395 token / 197 请求 / 249 工具；prepare 538,146、goal 899,249、child 0、summary 0、retry 0；记忆查询 7 / 命中 6；委派批次 0。该批不能用于收益或开销结论，原因是任务构造而非模型能力：

1. W01/W02/W04 的目标提示直接写出了期望的 `answer.json` 值，测到的是照抄与服从，记忆/协作没有发挥空间。
2. W02 工作区只有 `src/new.mjs` 文件存在，没有权威证据说明它是当前入口；`single-memory-off` 因此拒绝改 `docs/ENTRY.md`，而其它臂按文件命名猜中。这是蓝图缺陷，不是干净的能力失败。
3. W03 的团队臂一次也没有委派；任务规模也没有触发摘要或重试。因此 v2 的“团队”差异主要是工具/schema/提示开销，不是协作收益。

v2.1 据此修正：提示只给字段不给值；W02 在 `package.json.main` 提供权威当前入口，旧 `docs/ENTRY.md` 与旧记忆仍指向旧入口；W03 明确要求有只读委派工具时把两个独立调查委派出去；共同预算放宽到 32 请求 / 64 工具 / 320k token。v2 证据保留但不再与 v2.1 混算。v2.1 尚未执行。

## 命令与授权边界

冻结会先做完整零付费验证，然后写入四份 manifest：

```powershell
pnpm eval:memory-team --freeze .eval-evidence/memory-team-dev-v2-YYYYMMDD
pnpm eval:memory-team --validate-only .eval-evidence/memory-team-dev-v2-YYYYMMDD
```

零付费验证创建四份真实装配、16 个 episode 工作区、冻结记忆快照和独立验收自测，provider 请求为 0。manifest 明示 `paidExecutionAuthorized=false`；冻结本身不是付费授权。

付费执行必须由用户对当次批次明确授权，并在干净、与冻结来源相同的 HEAD 上运行：

```powershell
pnpm eval:memory-team --execute .eval-evidence/memory-team-dev-v2-YYYYMMDD --evidence-root .eval-evidence/memory-team-dev-v2-run-YYYYMMDD --max-usd 8.50
pnpm eval:memory-team --report .eval-evidence/memory-team-dev-v2-run-YYYYMMDD
```

执行前做模型回显探测与价格/来源复核；任何未知 usage、金额上限不足一个完整 episode 或基础设施/证据错误都会停止批次。复跑是新的付费批次，需要再次授权，不复用上一次的授权。原提案正式 16 工作流 × 4 条件 × 2 次重复的 128 个目标 episode 尚未构建或执行。

预览评价信息保留和行为，投影/报告缓存评价 CPU/I/O；不把总耗时单一差异当价值结论。默认开启需要真实证据，本实现保持默认关闭。
