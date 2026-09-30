# 06 增量对比

规格见 `docs/SPEC.md` 的第 5 节。

本阶段新增 `src/delta.mjs`，实现 `diffPlan(previousText, plan)`：把上一版由 `renderPlan` 渲染出来的文本解析回「模块名 → 批号」，再与当前计划比较，返回 `{ added, removed, moved }`。

要点：

- 只使用 `batches` 段的缩进行。`cycles` 段的成员行同样是缩进行，必须靠段落归属排除，不要把环成员读成批次成员。
- 渲染里的批号从 1 开始，对比时也按 1 开始，不要换算成下标。
- 文本不符合第 4 节的渲染格式时抛 `Error`，消息里带从 1 开始的行号（例如缺少 `batches` 段、出现无法识别的段落头、批次行格式不对）。
- 仓库里有一份上一版渲染结果 `data/previous.plan`。可以用 `data/app.deps` 走一遍完整流程核对增量结果。

完成后运行 `node check.mjs 6`，它会跑全部六个阶段的检查。
