# 02 拓扑排序

继续同一个工具。规格见 `docs/SPEC.md` 第 3 节的 `order`。

本阶段两件事：

1. 实现 `src/order.mjs` 的 `topoOrder(records, excluded = [])`，返回排好序的模块名数组。`excluded` 里的模块被当作不存在，依赖它们的模块也因此排不出来；本阶段直接传空数组即可。
2. 让 `src/pipeline.mjs` 的 `planPipeline(text)` 接上第一阶段已经写好的 `parseDeps`，返回值里带上 `records`、`external`、`order` 三个字段。`batches` 与 `cycles` 留给后面的阶段，暂时返回空数组。

要点：

- 依赖必须排在依赖者之前；在本文件内没有声明的依赖名（外部依赖）不参与排序。
- 并列时，每次从「依赖已经全部输出」的模块里选**首次出现位置最靠前**的一个。这条规则是逐项比对的对象，不能换成别的遍历次序。
- 排不出来的模块（依赖链不闭合）直接不出现在结果里，不要抛错。
- 不要在 `src/parse.mjs` 里重复实现解析：`planPipeline` 必须调用它。

完成后按 `docs/SPEC.md` 第 3 节自验，并回头确认第 1 节的行为仍然成立。
