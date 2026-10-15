# 修复分页边界

文件范围：仅可修改以下已有文件：`src/page.mjs`；其他已有文件（包括 package.json、规格和公开检查）不得修改。

`src/index.mjs` 导出的 `paginate(items, page, size)` 接收从 1 开始的页码。它必须返回对应连续切片；末页可以不足 `size`，越过末页返回空数组，空输入在合法参数下返回空数组。页码或页大小不是正整数时抛 `RangeError`。不得修改原数组。当前实现有边界偏移缺陷。请修复 `src/page.mjs`，保持公开接口与参数错误约定；其余文件不允许改。`node smoke.mjs` 可用于自测，但只覆盖第一页。
