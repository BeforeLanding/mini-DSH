# 03 渲染台账文本

继续同一个工具。规格见 `docs/SPEC.md` 第 3 节。

实现 `src/render.mjs` 的 `renderLedger(rows, meta)`。它从 `./checksum.mjs` 引入 `checksum(entries)` 并调用，把结果落在最后一行。

要点：

- 科目行缩进两个空格；`rows` 已经是升序的，不要再排。
- 每一行都以 `\n` 结尾，最后一行也带——`split('\n')` 之后应当多出一个空串。
- `src/checksum.mjs` 这一阶段还是骨架（返回 0），`node check.mjs 3` 因此只检查到第 3 节的格式，不去比对校验和的数值。

完成后运行 `node check.mjs 3`。
