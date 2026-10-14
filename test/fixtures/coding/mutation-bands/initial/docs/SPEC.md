# 分档规格

`src/bands.mjs` 导出的 `bandOf(score)` 把一个分数归入一个档位。

## 输入

- `score`：`number` 且有限。其余一律抛错——`NaN`、`Infinity`、`-Infinity` 与非 `number` 都在内。
- `score` 还必须落在 `[0, 100]` 的**闭区间**内：`0` 与 `100` 都是合法输入。

## 规则

1. 输入不合法时抛错（非有限数，或落在 `[0, 100]` 之外）。
2. `90 ≤ score ≤ 100` → `'A'`
3. `80 ≤ score < 90` → `'B'`
4. `70 ≤ score < 80` → `'C'`
5. `0 ≤ score < 70` → `'D'`
6. 返回值恒为 `'A'`／`'B'`／`'C'`／`'D'` 之一。

## 例子

- `bandOf(95)` → `'A'`
- `bandOf(85)` → `'B'`
- `bandOf(75)` → `'C'`
- `bandOf(65)` → `'D'`
- `bandOf(NaN)` → 抛错
- `bandOf(101)` → 抛错
