# 04 校验和

继续同一个工具。规格见 `docs/SPEC.md` 第 4 节。

实现 `src/checksum.mjs` 的 `checksum(entries)`，返回 N。

要点：

- 口径在排期说明的第 1 条里给出，`docs/SPEC.md` 不含它，仓库里也没有第二份。
- 返回**整数**，不是字符串；`checksum: ` 那一行由 `renderLedger` 自己拼。
- 只按流水求和，`skipped` 里的行不参与。
- `meta.entries` 已经是 `parseJournal` 的输出，直接用它，不要重新读文件。

完成后运行 `node check.mjs 4`，它会重跑第 1 到第 4 阶段的全部公开检查。
