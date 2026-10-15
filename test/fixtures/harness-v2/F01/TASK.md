# 为 slug 加可选分隔符

文件范围：仅可修改以下已有文件：`src/slug.mjs`；其他已有文件（包括 package.json、规格和公开检查）不得修改。

公开函数 `slugify(input, options)` 目前只能生成 `-` 分隔的 slug。新增 `options.separator`：缺省继续用 `-`，也允许 `_`；其他值抛 `RangeError`。先做 Unicode 小写与空白归一，再把每段之间的空白替换成分隔符；丢弃首尾空白。不得修改传入的选项对象；旧调用输出应逐字不变。只允许改 `src/slug.mjs`。运行 `node smoke.mjs` 可检查旧行为。
