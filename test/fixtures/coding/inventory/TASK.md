# inventory

calculateOrder 返回 { total, missing }：已知 SKU 按价格乘数量汇总，未知 SKU 按出现顺序列入 missing；formatOrder 输出 `Total: 12.50; missing: x,y`，无缺货时为 none。两个模块必须同步修改，输入不变。

运行 `node check.mjs` 查看公开检查。只能修改 `src/`；不得修改 `package.json` 或 `check.mjs`。独立验收覆盖更多输入，参考解不复制到工作区。
