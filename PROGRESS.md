# 开发进度

更新：2026-09-30。历史逐步记录已整体迁入 [2026-09-28 至 2026-09-30 归档](docs/history/PROGRESS-2026-09-28--2026-09-30.md)；本文件只维护当前状态、阻塞和下一步。

## 当前状态

- 主分支基线：TypeScript / Cordis 本地 coding agent harness。本地 `pnpm check`（74 文件）、150/150 测试、12 项 fixture 基线（初始 0/12、参考 12/12）通过；未调用付费模型。
- 运维整改 OPS-01～OPS-05 与文档结构整改已落地，提交号与 CI 证据见 [TASKS](docs/context-budget/TASKS.md) 和 [CHANGES](docs/context-budget/CHANGES.md)：部署改为 tag 触发，CI 的 main push 忽略纯文档，PROGRESS/TASKS 改为状态页，提交粒度规则改为可判断判据，ECS 标签与回滚规范已定义。
- 部署链路已切换为 tag 触发，但**尚未用真实 tag 验证**：仓库当前没有任何 tag，`v*.*.*` 触发路径与标签回滚流程均未实跑，首次发布前需验证。
- NX-04 补齐：F1–F3 的正式回归已并入 `pnpm test`，随四组合 CI 执行；映射见 [TASKS](docs/context-budget/TASKS.md)。
- Windows fixture 验收时限由 10 秒提高到 30 秒（`fixtureProcessTimeoutMs`）。原 10 秒预算在冷启动下不足：同一 merge 验收在 Ubuntu 为 120ms、在 windows-latest/Node22 超过 10 秒，而同机随后更重的流程仅用 1 秒。该改动只放宽挂起判定的等待上界，不改变验收语义。本地验证通过，远端四组合待提交后核验。

## 阻塞

- 无功能阻塞。
- 部署新路径未验证（见上）；首次发布前须实跑一次 tag 部署并核对回滚。
- T6 Biome 仍待只读诊断；在用户选择方案前不修改 Biome、依赖或 CI 门禁。

## 下一步

1. **NX-08 真实模型任务对照与估算误差实验**（下一主线）。前置已完成：子步骤、各自验收与提交边界已列入 [TASKS](docs/context-budget/TASKS.md)，整批上限与预注册口径已固定于 [PLAN](docs/context-budget/PLAN.md)，Windows fixture 时限已修。开始真实模型调用前不得再调整这些参数。
2. NX-09 / NX-10 最小演示不依赖 NX-08，可并行先行；真实模型结果一节须等 NX-08 完成后回填。
3. T6 Biome 只读诊断后由用户选择修到绿并设为门禁，或移除 Biome。

## 更新规则

- 本文件只在当前状态、实际阻塞或下一步发生变化时更新，不再逐提交追加历史日志。
- 任务清单只保留可扫描状态；详细实现与验收证据进入 CHANGES，阶段性过程进入 `docs/history/`。
- 未执行的检查明确标注；设计完成不写成功能完成，跨平台结论只引用实际 CI。
