# merge

合并配置：普通嵌套对象递归合并，数组和其他值整体覆盖；不得修改 base 或 overrides。`src/merge.mjs` 是公开入口，合并逻辑位于 `src/value.mjs`；两个模块的接口与实现必须同步修改。

运行 `node check.mjs` 查看公开检查。只能修改 `src/`；不得修改 `package.json` 或 `check.mjs`。独立验收覆盖更多输入，参考解不复制到工作区。
