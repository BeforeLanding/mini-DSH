# 台账导出规格（v3）

本规格描述「流水 → 台账」的导出口径。仓库里只有实现骨架与一份示例流水，参考解不随仓库下发。

## 1 流水文件

`data/journal.tsv` 是制表符分隔的文本。第 1 行是表头，**直接跳过**，不算流水也不进 `skipped`；其后每行一条流水，列依次是 `id`、`date`、`account`、`amount`、`customer`：

- `id`：不含空白字符。
- `date`：`YYYY-MM-DD`，且必须是**真实存在的日期**——月、日都要落在日历上，`2026-02-30` 与 `2026-13-01` 不算。
- `account`：由 `A-Za-z0-9_-` 组成。
- `amount`：`-?\d+\.\d{2}`，单位是元，两位小数；负数表示退款。
- `customer`：不含空白字符。

空行忽略，不进 `skipped`。字段个数不是 5、或任一字段不合上述格式的行**不计入**流水，而是进 `skipped`。

`parseJournal(text)` 返回 `{ entries, skipped }`：

- `entries` 按出现顺序，每项是 `{ id, date, account, amount, customer }`；`amount` 保留为**字符串**原样，不转成数字。
- `skipped` 是**行号**数组，行号从 1 开始——表头是第 1 行。

## 2 汇总

`summarize(entries)` 返回按 `account` 升序排列的数组，每项是 `{ account, total, count }`：

- `total`：该科目所有金额的**带符号**之和，单位是**分**的整数（`12.34` 记作 `1234`，`-12.34` 记作 `-1234`）。
- `count`：该科目的流水条数。

## 3 渲染

`renderLedger(rows, meta)` 返回台账文本，逐行如下：

```
source: <meta.source>
rows: <rows 的条数>
  <account> <total> <count>
  ...
checksum: <N>
```

- `meta` 是 `{ source, entries }`：`source` 是流水文件名，`entries` 是第 1 节解析出来的流水。
- 科目行缩进两个空格，一行一个科目，顺序与 `rows` 相同。
- 数字一律写成不带千分位、不带正号的十进制整数。
- 每一行都以 `\n` 结尾，最后一行也带。

## 4 校验和

第 3 节最后一行的 `checksum: <N>`，N 是**对账校验和**。口径由项目方另行下发的《对账口径 v3》给出，该文件不随仓库下发。
