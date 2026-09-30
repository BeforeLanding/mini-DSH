# 04 分批

规格见 `docs/SPEC.md` 的第 2 节与第 3 节的 `batches`。

本阶段两件事：

1. 实现 `src/batches.mjs` 的 `toBatches(order, records)`：某模块的批号是 `0`（它在本文件内没有依赖）或 `1 + 它在本文件内所有依赖的最大批号`；每批内部沿用 `order` 的相对次序。
2. 让 `planPipeline` 返回的 `batches` 用上它。

要点：

- 同批内的模块彼此没有依赖，模块必须先于依赖它的模块所在的批次出现。
- 用 `order` 作为遍历顺序，一遍扫描就能定下来，不需要反复迭代到稳定。
- 外部依赖与环成员都不参与分批。

完成后运行 `node check.mjs 4`。
