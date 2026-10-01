# audit

`src/audit.mjs` 的 `auditRecords` 逐条审计数据集 `data/records.jsonl`，把不符合规范形式的记录报出来；当前有大量违规。修正 `src/normalize.mjs` 的规整逻辑与 `src/audit.mjs` 的比对，使 `auditRecords` 对整份数据集返回空数组。

`check.mjs` 只给出一条断言结论，指不出是哪条记录、哪个字段不一致。`report.mjs` 逐条打印每一处不一致的原始记录、当前的规整结果与规范值。

运行 `node check.mjs` 查看公开检查。只能修改 `src/`；不得修改 `package.json`、`check.mjs`、`report.mjs` 或数据集。独立验收覆盖更多输入，参考解不复制到工作区。
