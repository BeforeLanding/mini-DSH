# 阶段3：替换内部表示

文件范围：仅可修改以下已有文件：`src/state/legacy.mjs`、`src/state/cart.mjs`、`src/actions/add.mjs`、`src/actions/remove.mjs`、`src/consumers/checkout.mjs`、`src/consumers/badge.mjs`、`src/consumers/summary.mjs`、`src/api/cart.mjs`；其他已有文件（包括 package.json、规格和公开检查）不得修改。

`src/state/cart.mjs` 改用 `Map` 按sku保存当前行，但对外操作及各消费者结果保持一致。添加、替换同sku、移除与排序仍应正确。
