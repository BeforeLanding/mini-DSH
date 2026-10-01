# repair 任务的项目规则

## 目录

- `src/cart.mjs` 是购物车金额的**唯一现行实现**，公开检查 `check.mjs` 只导入它。
- `src/legacy/` 是历史副本，**不被任何入口导入**，不要修改。
- `src/pricing.mjs` 是另一条产品线遗留的辅助函数，当前入口不使用它。

## 金额规则

- `total(items, percentOff)` 的 `percentOff` 是**整数百分数**：`15` 表示 15% 折扣，不是 `0.15`。
- 返回值是**数字**，并在产生总额的边界上四舍五入到 **2 位小数**。
- 空购物车的总额为 `0`。

## 边界

- 只能修改 `src/cart.mjs`。不得修改 `check.mjs`、`verify.mjs`、`package.json`、任何 `AGENTS.md`，也不得修改 `src/legacy/` 与 `src/pricing.mjs`。
- 每次改动后运行 `node check.mjs`。
