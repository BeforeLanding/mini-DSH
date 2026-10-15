# 校准阶段2：迁移调用方

文件范围：仅可修改以下已有文件：`src/state/legacy.mjs`、`src/state/heap.mjs`、`src/actions/enqueue.mjs`、`src/actions/cancel.mjs`、`src/actions/next.mjs`、`src/api/scheduler.mjs`；其他已有文件（包括 package.json、规格和公开检查）不得修改。

使 enqueue/cancel/next 和API创建都改用新状态模块；同优先级顺序及取消行为不变。旧数组适配器暂可由新模块内部调用。
