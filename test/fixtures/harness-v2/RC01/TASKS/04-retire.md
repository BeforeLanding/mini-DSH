# 校准阶段4：退役旧数组适配器

文件范围：仅可修改以下已有文件：`src/state/legacy.mjs`、`src/state/heap.mjs`、`src/actions/enqueue.mjs`、`src/actions/cancel.mjs`、`src/actions/next.mjs`、`src/api/scheduler.mjs`；其他已有文件（包括 package.json、规格和公开检查）不得修改。

清理所有生产路径对 `src/state/legacy.mjs` 的引用；终态仍要守住稳定顺序、取消、空队列与堆不变量。本题的初始项目和缺陷与正式R04购物车不同。
