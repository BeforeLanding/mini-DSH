# 规格：模块依赖 → 构建计划

本文件是权威规格。公开检查（`check.mjs`）与独立验收都按这里的行为判定；实现与规格不一致时以规格为准。

## 1. 输入格式

声明文件（`.deps`）是 UTF-8 文本，逐行解析：

```
# 井号开头是注释，整行忽略
core: util log
util:
log: util
```

- 一行一条声明，写成 `模块名: 依赖名 依赖名`。冒号后的列表可以为空。
- 模块名与依赖名由 `A-Za-z0-9_-` 组成，不得为空。
- 空行与首字符是 `#` 的行忽略。
- 同一模块名可以声明多次，依赖列表按**出现顺序合并去重**（不是覆盖）。
- 模块名的首次出现顺序有意义：它是所有并列选择的排序依据。
- 违反上列格式时抛 `Error`，消息里带出错的行号（从 1 开始），并且必须包含 `missing ':'`、`invalid module name`、`invalid dependency name` 三者之一。

## 2. 概念

- **模块**：在声明文件里作为冒号左侧出现过的名字。
- **外部依赖**：出现在某个依赖列表里、但从未作为模块声明过的名字。它不参与构建顺序。
- **环**：一个非平凡的强连通分量（成员数大于 1），或一个依赖自己的模块（自环）。
- **批次**：同一批内的模块彼此没有依赖关系。

## 3. 输出对象

`planPipeline(text)` 返回：

```js
{
  records: [{ name: 'core', deps: ['util', 'log'] }, /* ... */], // 模块按首次出现顺序；deps 已合并去重
  external: ['ghost'],                                           // 首次出现顺序
  cycles: [['alpha', 'beta']],                                   // 见下
  order: ['util', 'log', 'core'],                                // 见下
  batches: [['util'], ['log'], ['core']],                        // 见下
  blocked: [{ name: 'alpha', reason: 'cycle' }],                 // 见第 9 节；order 的补集
}
```

### cycles

- 每个环是一个数组，成员按**首次出现顺序**排列。
- 环之间按各自最早成员的首次出现位置排序。
- 只有一个成员时，必须真的是自环（例如 `solo: solo`）才算环。

### order

- 只包含**不属于任何环、也不依赖任何环成员**（直接或间接）的模块。
- 依赖在前：任何模块都排在它在本文件内声明的依赖之后。外部依赖不参与排序。
- 并列时：每次从「依赖已经全部输出」的模块中选**首次出现位置最靠前**的一个输出。这条规则必须严格实现，`order` 是逐项比对的对象。

### batches

- `batches` 是 `order` 的分层结果：某模块的批号是 `0`（它在本文件内没有依赖）或 `1 + 它在本文件内所有依赖的最大批号`。
- 每批内部的次序沿用 `order` 中的相对次序。
- 批号从 0 开始，输出时不跳号。

## 4. 渲染格式

`renderPlan(plan, { source })` 返回一段文本，逐字固定：

```
source: example.deps
order: 7
batches: 5
  1: util
  2: log, store
  3: core
  4: api
  5: cli, worker
external: missing-lib
cycles: 0
```

- 批号从 1 开始（`batches` 数组下标加 1），行首两个空格，模块名之间用 `, ` 连接。
- `external` 为空时写 `external: (none)`，不为空时用 `, ` 连接。
- `cycles: <个数>` 单独一行；每个环再占一行，编号从 1 开始，格式与批次行相同。
- 整个字符串以**一个换行符**结尾，没有多余的空行。

## 5. 增量对比

`diffPlan(previousText, plan)` 把上一版渲染文本解析回「模块名 → 批号」，再与当前计划比较：

```js
{ added: ['tool'], removed: ['legacy'], moved: [{ name: 'tool', from: 3, to: 2 }] }
```

- `added`：本版有、上版没有的模块，按本版顺序（`batches` 展平后的次序）。
- `removed`：上版有、本版没有的模块，按上版出现的顺序。
- `moved`：两版都有但批号不同的模块，按本版顺序，写成 `{ name, from, to }`。
- 解析只使用 `batches` 段的缩进行；其他段落的缩进行（例如 `cycles` 的成员行）必须忽略。
- 文本不符合第 4 节的渲染格式时抛 `Error`，消息里带行号。

## 6. 模块与导出

| 文件 | 导出 |
| --- | --- |
| `src/parse.mjs` | `parseDeps(text)` → `{ records, external }` |
| `src/order.mjs` | `topoOrder(records, excluded = [])` → `string[]` |
| `src/cycles.mjs` | `findCycles(records)` → `string[][]` |
| `src/batches.mjs` | `toBatches(order, records)` → `string[][]` |
| `src/report.mjs` | `renderPlan(plan, options)` → `string` |
| `src/delta.mjs` | `diffPlan(previousText, plan)` → `{ added, removed, moved }` |
| `src/plan-parse.mjs` | `parsePlan(text)` → 第 7 节的对象 |
| `src/plan-merge.mjs` | `mergePlans(texts, options)` → `string` |
| `src/blocked.mjs` | `blockReasons(records, cycles)` → `{ name, reason }[]` |
| `src/audit.mjs` | `renderAudit(plan)` → `string` |
| `src/pipeline.mjs` | `planPipeline(text)` → 第 3 节的对象 |

`topoOrder` 的 `excluded` 是「不参与排序的模块名」：它们被当作不存在，依赖它们的模块也因此排不出来。

## 7. 反向解析

`parsePlan(text)` 把第 4 节渲染出来的文本解析回：

```js
{ source: 'example.deps', order: ['util', 'log'], batches: [['util'], ['log']], external: ['missing-lib'], cycles: [] }
```

- `batches` 是数组的数组，下标 `0` 对应文本里的批号 `1`；`order` 是 `batches` 展平的结果。
- `external` 与 `cycles` 同样解析出来；`external: (none)` 对应空数组。
- 缩进行只归属它所在的段落。`cycles` 的成员行与 `batches` 的批次行格式相同，必须靠段落归属区分。
- 五个段落必须齐全，并且按 `source` → `order` → `batches` → `external` → `cycles` 的顺序出现。
- 段落里的条目编号必须从 `1` 开始、每次加 `1`、不跳号。
- 各段段落头的数字必须与它下面条目的实际数量一致；`batches` 段里出现重复模块名同样算不合法。
- 以上任何一条不成立时抛 `Error`，消息里带出错的行号（从 1 开始）。

## 8. 计划合并

`mergePlans(texts, { source })` 把若干份渲染文本合并成一份渲染文本：

- 每份输入按第 7 节解析，结果按第 4 节渲染，`source` 用参数给出的名字。
- 模块的批号取它在各输入里的**最大**批号。这样合并结果里没有任何模块会排到它在某一份输入中的位置之前。
- 同一批内的次序：先按输入数组的顺序，再按该输入内 `order` 的次序；同一模块只出现一次。
- 批号取最大值可能让中间某些批号空出来，按第 3 节「输出时不跳号」的约定压掉。
- `external` 取并集，按输入顺序、输入内次序。`cycles` 取并集，成员集合相同的环只留最先出现的那一份。
- `texts` 为空数组时抛 `Error`。

## 9. 阻塞原因

`blockReasons(records, cycles)` 给出 `order` 的补集：每个排不出来的模块一条 `{ name, reason }`，按模块首次出现顺序。

`reason` 取下列二者之一，**按此优先级判定**（一个模块可能同时命中两条）：

| reason | 含义 |
| --- | --- |
| `cycle` | 它自己是环成员 |
| `depends-on-cycle` | 它自己不在环里，但直接或间接依赖某个环成员 |

判定要沿依赖链传递：依赖一个「依赖环成员的模块」同样得到 `depends-on-cycle`。

外部名不构成阻塞：第 2 节规定外部依赖不参与构建顺序，`tool: util ghost` 里的 `tool` 照常排进 `order`，
因此「依赖链里有从未声明的名字」不是一种阻塞原因。

## 10. 审计报告

`renderAudit(plan)` 把 `blocked` 与 `cycles` 渲染成逐字固定的文本，排版沿用第 4 节：

```
blocked: 2
  1: alpha (cycle)
  2: tool (depends-on-cycle)
cycles: 2
  1: alpha, beta, delta
  2: solo
```

- 段落头一行，条目行两个空格缩进加 `序号: `，序号从 1 开始。
- 阻塞条目写成 `名字 (原因)`；环条目沿用第 4 节的 `, ` 连接。
- 空段落只留段落头，不写条目行（例如没有阻塞时只有 `blocked: 0` 一行）。
- 整个字符串以**一个换行符**结尾。

公开检查是 `node check.mjs <阶段号>`，跑第 1 到该阶段的全部断言；不带参数则跑全部。`data/app.deps` 与 `data/previous.plan` 是示例输入，不要修改。
