# 开发进度

更新：2026-09-30。历史逐步记录已整体迁入 [2026-09-28 至 2026-09-30 归档](docs/history/PROGRESS-2026-09-28--2026-09-30.md)；本文件只维护当前状态、阻塞和下一步。

## 当前状态

- 主分支基线：TypeScript / Cordis 本地 coding agent harness。本地 `pnpm check`（74 文件）、153/153 测试、12 项 fixture 基线（初始 0/12、参考 12/12）通过；未调用付费模型。
- 运维整改 OPS-01～OPS-05 与文档结构整改已落地，提交号与 CI 证据见 [TASKS](docs/context-budget/TASKS.md) 和 [CHANGES](docs/context-budget/CHANGES.md)：部署改为 tag 触发，CI 的 main push 忽略纯文档，PROGRESS/TASKS 改为状态页，提交粒度规则改为可判断判据，ECS 标签与回滚规范已定义。
- 部署链路已切换为 tag 触发，但**尚未用真实 tag 验证**：仓库当前没有任何 tag，`v*.*.*` 触发路径与标签回滚流程均未实跑，首次发布前需验证。
- NX-04 补齐：F1–F3 的正式回归已并入 `pnpm test`，随四组合 CI 执行；映射见 [TASKS](docs/context-budget/TASKS.md)。
- Windows fixture 验收时限由 10 秒提高到 30 秒（`fixtureProcessTimeoutMs`）。原 10 秒预算在冷启动下不足：同一 merge 验收在 Ubuntu 为 120ms、在 windows-latest/Node22 超过 10 秒，而同机随后更重的流程仅用 1 秒。该改动只放宽挂起判定的等待上界，不改变验收语义。本地验证通过；推送后 [CI 36665007092](https://github.com/BeforeLanding/mini-DSH/actions/runs/36665007092) 四组合 attempt=1 全绿、无重跑，同一 SHA 未触发 Deploy ECS。但该次 Windows Node22 上同一 merge 验收用时 312ms，未触及新上界，故这次只证明 flake 未复现，不构成修复有效的证明；需后续多轮 Windows Node22 不再出现 `ETIMEDOUT` 才能累积证据。

## 阻塞

- 无功能阻塞。
- 部署新路径未验证（见上）；首次发布前须实跑一次 tag 部署并核对回滚。
- T6 Biome 只读诊断已有结论：仓库**没有 `biome.json`**，Biome 以默认规则（制表符、双引号、导入排序）运行，与全仓库既有风格相反，因此对每个文件都报错；`pnpm check` 与 CI 均未接入 `lint`，该脚本从未绿过。在用户选择处置方案前不修改 Biome、依赖或 CI 门禁。

## 下一步

1. **NX-08b 评测运行器与整批上限强制**（下一主线）。NX-08a 的导出契约已完成：`requestTrace` 现在给出可判定的投影归属、`unsentProjections` 与含主动/审批时间的 run 终值 `counters`，运行器据此导出证据。b 步仍离线（mock 模型跑完全部 12 个任务），不调用真实模型；整批上限与预注册口径已固定于 [PLAN](docs/context-budget/PLAN.md)，开始真实模型调用前不得再调整这些参数。
2. NX-09 / NX-10 最小演示不依赖 NX-08，可并行先行；真实模型结果一节须等 NX-08 完成后回填。
3. T6 Biome 处置方案由用户选择：修到绿并设为门禁，或移除 Biome（诊断结论见“阻塞”）。

## 更新规则

- 本文件只在当前状态、实际阻塞或下一步发生变化时更新，不再逐提交追加历史日志。
- 任务清单只保留可扫描状态；详细实现与验收证据进入 CHANGES，阶段性过程进入 `docs/history/`。
- 未执行的检查明确标注；设计完成不写成功能完成，跨平台结论只引用实际 CI。
