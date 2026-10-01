# audit

数据集的每条记录都带一份期望的规范值：`src/normalize.mjs` 把原始字段规整之后，必须逐条等于该记录的 `expected`。当前审计有大量不一致，`src/audit.mjs` 的 `auditRecords` 把它们逐条报出来。修正规整逻辑与审计比对，使 `auditRecords` 对 `data/records.jsonl` 返回空数组。

`check.mjs` 只给出一条断言结论，指不出是哪条记录、哪个字段不一致。`report.mjs` 打印每一条不一致的原始值、规整结果、期望值与对应字段的规范形式。

运行 `node check.mjs` 查看公开检查。只能修改 `src/`；不得修改 `package.json`、`check.mjs`、`report.mjs` 或数据集。独立验收覆盖更多输入，参考解不复制到工作区。
