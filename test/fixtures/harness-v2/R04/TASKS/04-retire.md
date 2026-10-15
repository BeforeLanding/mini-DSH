# 阶段4：退役旧适配器

文件范围：仅可修改以下已有文件：`src/state/legacy.mjs`、`src/state/cart.mjs`、`src/actions/add.mjs`、`src/actions/remove.mjs`、`src/consumers/checkout.mjs`、`src/consumers/badge.mjs`、`src/consumers/summary.mjs`、`src/api/cart.mjs`；其他已有文件（包括 package.json、规格和公开检查）不得修改。

移除生产路径对 `src/state/legacy.mjs` 的所有引用，让它不再承担运行逻辑；保留 `docs/CART.md` 中的所有业务行为。终态验收既检查行为，也检查表示与依赖迁移完成。
