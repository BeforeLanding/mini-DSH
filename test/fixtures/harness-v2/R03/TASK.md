# 合并重复的运单规则而保留市场差异

文件范围：仅可修改以下已有文件：`src/rules/domestic.mjs`、`src/rules/international.mjs`、`src/rules/shared.mjs`；其他已有文件（包括 package.json、规格和公开检查）不得修改。

`docs/RULES.md` 和 `cases/` 说明国内、国际两套验证规则；`cases/regressions.ndjson` 包含跨市场边界样例，可正常搜索与聚合。当前两个模块重复了重量和尺寸通用部分，请提取到已预留的 `src/rules/shared.mjs`，让两条路径调用同一个 `validateCore(order,maxWeight)`；其结果为 `null` 或 `'weight'`/`'dimensions'`。国内保留邮编要求与20kg上限，国际保留报关码要求与10kg上限。公开 `validateShipment(order,market)` 既有返回格式和边界行为必须保持。只可改三个 rules 文件。验收既测业务差分，也检查共享模块确实供两个消费者使用；不能只添加一个无人调用的共享函数。
