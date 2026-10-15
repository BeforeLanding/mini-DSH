# 将金额计算与收据渲染分离

现有 `renderReceipt(lines)` 把金额计算和显示耦合在一起。提取并公开 `calculateTotal(lines)`，返回以分为单位的整数总额；`renderReceipt` 必须调用这项计算，继续返回旧格式 `Total: $12.34`。每项 `{ unitCents, quantity }` 使用整数，空列表总额为 0；输入数组和行对象不得被修改。允许改 `src/pricing.mjs`、`src/receipt.mjs`、`src/index.mjs`。`node smoke.mjs` 只检查旧显示路径，终态同时需要新接口与旧行为。
