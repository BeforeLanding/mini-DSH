# 开发进度

更新：2026-09-30。历史逐步记录已整体迁入 [2026-09-28 至 2026-09-30 归档](docs/history/PROGRESS-2026-09-28--2026-09-30.md)；本文件只维护当前状态、阻塞和下一步。

## 当前状态

- 主分支基线：TypeScript / Cordis 本地 coding agent harness。本地 `pnpm check`（82 文件）、172/172 测试、12 项 fixture 基线（初始 0/12、参考 12/12）通过。`pnpm check`、`pnpm test`、`pnpm eval:offline`、`pnpm fixtures:check` 均不调用付费模型。
- NX-08d0 完成：首次真实调用的设施补齐，3 个提交（`8fd78a9`、`9eb3769`、`4d10f2c`）已推送，三个 SHA 上 CI 四组 success、attempt=1（[4d10f2c](https://github.com/BeforeLanding/mini-DSH/actions/runs/36681430450)），同一批推送未触发 Deploy ECS。修复了评测路径上输入目标 65,536 与 1,000,000 窗口从未生效（投影不裁剪、`context_overflow` 不触发）的问题；补齐 run 结论分类与显式成功率口径；新增 `pnpm eval:screening` 真实适配器入口与逐 run 证据落盘。**自 2026-09-30 起开始调用付费模型**。
- 真实调用烟测（2026-09-30，`merge` 两次）：均 completed 且通过独立验收，退出码 0。第一次 5 请求 / 24,677 token，第二次 9 请求 / 119,689 token（输入 104,691、输出 14,998，其中 reasoning 10,700）。差异来自 thinking 输出与工具次数导致的输入累积重发。协议探测记录：请求体写 `deepseek-v4-flash` 时服务端回显 `model=deepseek-flash`。完整证据在 `.eval-evidence/screening-merge/`（不入库），[详细证据](docs/context-budget/CHANGES.md#nx-08d0-3-真实适配器评测入口与逐-run-证据落盘)。
- 运维整改 OPS-01～OPS-05 与文档结构整改已落地，提交号与 CI 证据见 [TASKS](docs/context-budget/TASKS.md) 和 [CHANGES](docs/context-budget/CHANGES.md)：部署改为 tag 触发，CI 的 main push 忽略纯文档，PROGRESS/TASKS 改为状态页，提交粒度规则改为可判断判据，ECS 标签与回滚规范已定义。
- 部署链路已切换为 tag 触发，但**尚未用真实 tag 验证**：仓库当前没有任何 tag，`v*.*.*` 触发路径与标签回滚流程均未实跑，首次发布前需验证。
- NX-04 补齐：F1–F3 的正式回归已并入 `pnpm test`，随四组合 CI 执行；映射见 [TASKS](docs/context-budget/TASKS.md)。
- NX-08a／NX-08b 完成：request trace 补齐评测导出（投影按 `requestId` 归属、未发出请求单列、run 终值计数含主动与审批时间）；`scripts/eval-runner.ts` 按阶段核算 runs/requests/tokens 并在触顶时中止阶段而不记作任务失败，`pnpm eval:offline` 用模拟模型离线跑完筛查阶段 12 个任务（12 completed、12 accepted、66 请求，退出码 0）。离线 token 总数在多次运行间有 ±30 量级抖动（实测 194,439～194,466），来源是 bash 工具结果里的 `durationMs` 位数不同且参与输入估算，请求数、工具数与逐项验收结论稳定；此前记录的单一数值 194,474 属同类抖动，不可复现。两者均未调用真实模型。
- NX-08c 完成：40 个样本（中文、英文、代码、schema 各 10）对照 DeepSeek 官方离线 tokenizer 测量输入估算偏差，结论标注估算器 SHA-256 与核验日期（2026-09-30）。自然语言一致高估（中文 +28%、英文 +40%）；代码与 JSON 不是一致安全，40 个样本中 4 个低估、最深 −22.5%，**超过容量余量的 10%**。参考值与语料一并固定，`pnpm eval:estimate` 在估算器或语料变化时以非零退出码提示重新测量。未调用真实模型。NX-08a／b／c 一次性推送，[CI 36672834797](https://github.com/BeforeLanding/mini-DSH/actions/runs/36672834797) 在该 SHA 上 Ubuntu/Windows × Node22/24 四组 success、attempt=1，同一 SHA 无 Deploy ECS run。
- Windows fixture 验收时限由 10 秒提高到 30 秒（`fixtureProcessTimeoutMs`）。原 10 秒预算在冷启动下不足：同一 merge 验收在 Ubuntu 为 120ms、在 windows-latest/Node22 超过 10 秒，而同机随后更重的流程仅用 1 秒。该改动只放宽挂起判定的等待上界，不改变验收语义。本地验证通过；推送后 [CI 36665007092](https://github.com/BeforeLanding/mini-DSH/actions/runs/36665007092) 四组合 attempt=1 全绿、无重跑，同一 SHA 未触发 Deploy ECS。但该次 Windows Node22 上同一 merge 验收用时 312ms，未触及新上界，故这次只证明 flake 未复现，不构成修复有效的证明；需后续多轮 Windows Node22 不再出现 `ETIMEDOUT` 才能累积证据。

## 阻塞

- 无功能阻塞。
- NX-08e 的任务集尚不满足对照前提：两臂只有在历史超过输入目标 65,536 时才可能有差异，而现有 12 个 fixture 实测最大估算输入仅 27,147（`merge`，9 次请求）。需要先测量或构造能超过该阈值的任务，否则「全历史 vs 现有裁剪」会得到两臂完全等价的假结论。该项不阻塞 NX-08d 筛查跑。
- 部署新路径未验证（见上）；首次发布前须实跑一次 tag 部署并核对回滚。
- T6 Biome 只读诊断已有结论：仓库**没有 `biome.json`**，Biome 以默认规则（制表符、双引号、导入排序）运行，与全仓库既有风格相反，因此对每个文件都报错；`pnpm check` 与 CI 均未接入 `lint`，该脚本从未绿过。在用户选择处置方案前不修改 Biome、依赖或 CI 门禁。

## 下一步

1. **NX-08d 筛查跑（12 任务 × 1）**（下一主线，设施已就绪）。命令为 `pnpm eval:screening`；前置的协议探测、模型名与窗口显式化、证据落盘与成本打印已由 NX-08d0 完成。开跑后不得再单独调整某一臂或某次重复，整批上限与预注册参数见 [PLAN](docs/context-budget/PLAN.md#nx-08-评测批次上限预注册)。产出须报告原始分子/分母与失败案例；不可行任务如实标记、不计入成功率。按烟测用量（单任务 5～9 请求、2.5 万～12 万 token）预计整批在百万 token 量级，远低于 8,000,000 的整批上限。
2. NX-09 / NX-10 最小演示不依赖 NX-08，可并行先行；真实模型结果一节须等 NX-08 完成后回填。
3. T6 Biome 处置方案由用户选择：修到绿并设为门禁，或移除 Biome（诊断结论见“阻塞”）。

## 更新规则

- 本文件只在当前状态、实际阻塞或下一步发生变化时更新，不再逐提交追加历史日志。
- 任务清单只保留可扫描状态；详细实现与验收证据进入 CHANGES，阶段性过程进入 `docs/history/`。
- 未执行的检查明确标注；设计完成不写成功能完成，跨平台结论只引用实际 CI。
