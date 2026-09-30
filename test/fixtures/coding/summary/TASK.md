# summary

按 category 聚合事件：每类返回 { category, count, total }，按 category 字母顺序排列；空输入返回空数组，输入不变。amount 为数字，可为负数或 0。评测会以有限请求预算分段运行；停止后继续同一任务，保留已有失败检查，只执行未完成编辑和后续验证。

运行 `node check.mjs` 查看公开检查。只能修改 `src/`；不得修改 `package.json` 或 `check.mjs`。独立验收覆盖更多输入，参考解不复制到工作区。
