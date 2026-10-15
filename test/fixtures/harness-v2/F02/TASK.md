# 查询过滤贯穿解析、服务与调用方

订单查询 `queryOrders(rows, query)` 新增两个可选条件：`status` 为 `open` 或 `closed`，`minTotal` 为非负整数分值，且总额等于阈值时应保留。两个条件同时给出须取交集；未给条件时保持旧的全部结果与顺序，空结果返回 `[]`。非法条件抛 `RangeError`。`legacyList(rows)` 的旧接口保持原样。请同步 `src/query/parse.mjs`、`src/query/predicate.mjs`、`src/api/handler.mjs`，不可修改其他文件或输入行对象。公开 smoke 仅覆盖旧调用。
