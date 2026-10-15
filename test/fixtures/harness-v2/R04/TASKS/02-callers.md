# 阶段2：迁移调用方

文件范围：仅可修改以下已有文件：`src/state/legacy.mjs`、`src/state/cart.mjs`、`src/actions/add.mjs`、`src/actions/remove.mjs`、`src/consumers/checkout.mjs`、`src/consumers/badge.mjs`、`src/consumers/summary.mjs`、`src/api/cart.mjs`；其他已有文件（包括 package.json、规格和公开检查）不得修改。

把新增、移除及 checkout/badge/summary 三处消费者切到 `src/state/cart.mjs`；API创建也从该模块取状态。阶段1行为不变。
