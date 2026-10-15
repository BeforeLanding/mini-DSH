# 阶段1：基本聚合

实现 `createReport()`：`add({id,account,amountCents})` 加一条事件；`snapshot()` 返回按账户汇总的 `{account,totalCents}`。先保证单条与不同账户成立。只允许修改 `src/api/report.mjs`。
