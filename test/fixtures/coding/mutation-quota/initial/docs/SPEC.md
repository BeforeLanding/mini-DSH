# 配额规格

`src/quota.mjs` 导出的 `takeWithin(entries, limit)` 按顺序取条目，直到再加一条就会超过上限。

## 输入

- `entries`：数组。每条是一个对象，必须带一个**非空字符串** `id` 与一个**非负有限数** `amount`。
- `limit`：非负有限数。`0` 是合法输入。

## 规则

1. `entries` 不是数组，或 `limit` 不是非负有限数时抛错。
2. 某一条 `entry` 不合法（不是对象、`id` 不是非空字符串、`amount` 不是非负有限数）时抛错。
3. 从第一条起按顺序累加。**若加入这一条会让总和超过 `limit`，就停在它前面**——因此总和**恰好等于** `limit` 的那一条要被取走。越限之后不再看后面的条目，后面的条目也**不再被校验**。
4. 返回 `{ ids, total }`：`ids` 是取走的条目 `id`，顺序与输入一致；`total` 是取走的那些 `amount` 之和。
5. 空数组返回 `{ ids: [], total: 0 }`。

## 例子

- `takeWithin([], 10)` → `{ ids: [], total: 0 }`
- `takeWithin([{ id: 'a', amount: 3 }, { id: 'b', amount: 4 }], 10)` → `{ ids: ['a', 'b'], total: 7 }`
- `takeWithin('nope', 1)` → 抛错
