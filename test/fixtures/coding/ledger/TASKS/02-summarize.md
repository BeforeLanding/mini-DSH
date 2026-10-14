# 02 按科目汇总

继续同一个工具。规格见 `docs/SPEC.md` 第 2 节。

实现 `src/summarize.mjs` 的 `summarize(entries)`：按 `account` 升序返回 `{ account, total, count }`。

要点：

- 金额是两位小数字符串，先换算成**分**的整数再相加；`Number('8.70') * 100` 会得到 `869.9999999999999`，所以按字符串自己拼整数，不要走浮点乘除。
- `total` 保留符号：退款是负数，同一科目里的退款要减掉。
- 升序按 `account` 的字典序，不要按出现顺序，也不要按 `count` 排。
- 不要在 `src/summarize.mjs` 里重复实现解析：它的入参就是第 1 阶段 `parseJournal` 的输出。

完成后运行 `node check.mjs 2`，它会同时重跑第 1 阶段的检查。
