# 校准阶段3：改用二叉堆

文件范围：仅可修改以下已有文件：`src/state/legacy.mjs`、`src/state/heap.mjs`、`src/actions/enqueue.mjs`、`src/actions/cancel.mjs`、`src/actions/next.mjs`、`src/api/scheduler.mjs`；其他已有文件（包括 package.json、规格和公开检查）不得修改。

新状态模块内部改为二叉最小堆 `data` 数组，入队、取下一个及取消后仍保持堆不变量。不能靠每次全量排序代替堆。旧公开调度行为保持。
