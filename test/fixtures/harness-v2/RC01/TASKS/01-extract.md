# 校准阶段1：提取队列模块

调度器当前使用数组队列。在 `src/state/heap.mjs` 提供 `newQueue/push/pop/remove`，初期可委托旧实现；保持优先级小者先出、同优先级按入队先后出。只改元数据允许的文件。
