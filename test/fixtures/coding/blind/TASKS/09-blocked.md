# 09 阻塞原因

规格见 `docs/SPEC.md` 的第 9 节。

本阶段两件事：

1. 新增 `src/blocked.mjs`，实现 `blockReasons(records, cycles)`：给出 `order` 的补集——每个排不出来的模块一条 `{ name, reason }`。
2. 让 `planPipeline` 的返回值带上 `blocked` 字段（`src/pipeline.mjs`）。

要点：

- 只有两种原因，按 `cycle` > `depends-on-cycle` 的**优先级**判定。一个模块可能同时命中两条，优先级由规格写死，不能由你的遍历次序决定。
- `depends-on-cycle` 要沿依赖链**传递**：依赖一个「依赖环成员的模块」同样得到它。
- 沿链走时要挡重复访问。环成员在递归进去之前就该被判定命中，否则会绕圈。
- **外部名不是一种阻塞原因**：第 2 节规定外部依赖不参与构建顺序，所以依赖 `ghost` 的模块照常排进 `order`。只有环才会让人排不出来。
- `blocked` 不改变 `order` 的取值，它只是把「为什么没排出来」写下来。既有阶段要求的行为必须仍然成立。

完成后按 `docs/SPEC.md` 第 9 节自验。
