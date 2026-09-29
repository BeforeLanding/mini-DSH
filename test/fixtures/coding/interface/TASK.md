# 同步金额接口与调用方

将 `src/pricing.mjs` 的 `calculateSubtotal(items)` 从返回数字改为返回 `{ amount, currency: 'CNY' }`；items 中 price 为非负数字、quantity 为非负整数，空数组 amount 为 0，不改变原数组。

同步 `src/receipt.mjs` 的 `formatReceipt(items)` 调用方，输出 `CNY 12.50` 这样的货币和两位小数文本。不得修改 package.json 或 check.mjs。运行 `node check.mjs`；独立验收分别检查接口和调用方，避免只修一处或返回固定答案。
