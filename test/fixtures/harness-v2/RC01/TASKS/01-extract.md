# 校准阶段1：提取队列模块

文件范围：仅可修改以下已有文件：`src/state/legacy.mjs`、`src/state/heap.mjs`、`src/actions/enqueue.mjs`、`src/actions/cancel.mjs`、`src/actions/next.mjs`、`src/api/scheduler.mjs`；其他已有文件（包括 package.json、规格和公开检查）不得修改。

调度器当前使用数组队列。在 `src/state/heap.mjs` 提供 `newQueue/push/pop/remove`，初期可委托旧实现；保持优先级小者先出、同优先级按入队先后出。只改元数据允许的文件。
