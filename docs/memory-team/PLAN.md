# 项目记忆与只读协作实施计划

## 当前范围决定（2026-10-27）

用户决定暂缓本专题：核心功能已实现并通过 PR #7 合入 main，维持现有实现与默认关闭状态；暂不继续功能开发、评测器扩展或新批次实验。当前组件优化测评不纳入记忆或协作因子。已有代码、功能回归、v2/v2.1 原始证据及 v2.2 冻结件保留，不删除或追溯改写。

优先完成其它组件优化；待任务与测评能够检验这两项的实际作用后，再由用户决定是否恢复开发和独立效果评估。该条件不是自动恢复或付费授权。下文实施顺序保留为历史计划。

实施以 [需求](REQUIREMENTS.md)、[任务](TASKS.md) 和 [变更证据](CHANGES.md) 为准。保留现有 Cordis 服务、JSONL 和 createHarness，共用生产与测试装配。

- A：MemoryStore → 来源/锚点检索与 MemoryView → 提案审核及 CLI。
- B：角色能力 → 根任务预算账本（所有模型用途统一准入）。
- C：批次委派 → 中断与恢复 → 固定候选版本审查。
- D：零模型演示与消融协议准备；真实模型效果另行授权。

每步提交须能独立验收与回退，先完成当前步骤再进入下一步。默认建议额度沿用原方案：记忆返回最多 5 条/2048 估算 token/8192 字节；并发 2、每任务最多 4 个子 Agent、深度 1；根任务 64 请求/128 工具/2M token/15 分钟 wall time，预留根 Agent 32 请求/1M token。配置必须验证并展示，估算 token 不视为供应商硬计费上限。

源码边界：memory-{contracts,store,retriever,runtime} 与 memory 插件；agent-capabilities；task-group-budget；delegation-{contracts,runtime,recovery} 与 delegation 插件。只有集成到 Harness/CLI 并通过失败边界测试后，才标相应能力完成。
