# query

查询串回归需要先定位：`diagnostics/trace.log` 超过默认读取页，在日志中搜索 `NX05B-QUERY-LOCATE` 并读取附近行，再检查指向的源码。构建稳定查询串：键按字母顺序排列，null/undefined 省略，数组元素依次重复键；键和值均使用 encodeURIComponent，布尔值和数字转字符串；输入不变。

运行 `node check.mjs` 查看公开检查。只能修改 `src/`；不得修改 `package.json`、`check.mjs` 或诊断日志。独立验收覆盖更多输入，参考解不复制到工作区。
