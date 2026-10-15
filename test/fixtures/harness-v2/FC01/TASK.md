# 校准题：功能开关依赖闭包

`docs/ROLLOUT.md` 与 `logs/decisions.ndjson` 记录逐步发布。新增 `isEnabled(flag,settings)` 的依赖约束：某开关自身为真，且所有直接/间接依赖都为真时才开启；缺失依赖为false；循环依赖抛 `RangeError`。独立开关旧行为不变。只改 `src/eval/resolve.mjs`，不得按日志中的特定flag名硬编码。可正常搜索相关发布记录。本题为独立校准根问题。
