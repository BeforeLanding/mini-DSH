# csv

CSV 回归需要先定位：`diagnostics/trace.log` 超过默认读取页，在日志中搜索 `NX05B-CSV-LOCATE` 并读取附近行，再检查指向的源码。解析单行 CSV：逗号分隔、双引号字段可含逗号、连续两个双引号表示字面双引号，保留空字段。输入保证引号配对，不处理跨行。

运行 `node check.mjs` 查看公开检查。只能修改 `src/`；不得修改 `package.json`、`check.mjs` 或诊断日志。独立验收覆盖更多输入，参考解不复制到工作区。
