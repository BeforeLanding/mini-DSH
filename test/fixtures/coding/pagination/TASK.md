# pagination

分页回归需要先定位：`diagnostics/trace.log` 超过默认读取页，在日志中搜索 `NX05B-PAGE-LOCATE` 并读取附近行，再检查指向的源码。实现从 1 开始的分页：返回 { items, totalPages }，page 和 pageSize 均为正整数；越过末页返回空 items，输入数组不变。

运行 `node check.mjs` 查看公开检查。只能修改 `src/`；不得修改 `package.json`、`check.mjs` 或诊断日志。独立验收覆盖更多输入，参考解不复制到工作区。
