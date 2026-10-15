# 阶段1：提取状态模块

文件范围：仅可修改以下已有文件：`src/state/legacy.mjs`、`src/state/cart.mjs`、`src/actions/add.mjs`、`src/actions/remove.mjs`、`src/consumers/checkout.mjs`、`src/consumers/badge.mjs`、`src/consumers/summary.mjs`、`src/api/cart.mjs`；其他已有文件（包括 package.json、规格和公开检查）不得修改。

实现 `src/state/cart.mjs`，让它提供 `newState/put/drop/lines` 与旧状态同形的操作，暂可委托旧适配器。公开业务行为保持。不要修改规格文件。
