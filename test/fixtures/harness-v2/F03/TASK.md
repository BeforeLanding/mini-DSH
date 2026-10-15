# 根据迁移记录实现旧格式导入

`docs/versions/` 和 `samples/` 描述 v1 → v2 的CSV迁移，`logs/imports.ndjson` 记录线上混合文件。公开函数 `importRecords(text)` 目前只接受 v2。新增v1兼容：表头 `customer,total`，金额是有两位小数的非负十进制字符串；转成整数分，返回与v2相同的 `{customer,totalCents}`。v2表头 `client,cents` 的行为必须保持；空表（只有表头）返回 `[]`，未知表头和非法金额抛 `RangeError`。输入文件不带引号/内嵌逗号。只允许改 `src/version/detect.mjs`、`src/version/v1.mjs`、`src/import/dispatch.mjs`。可正常检索迁移日志和样例，不必读取每条日志。
