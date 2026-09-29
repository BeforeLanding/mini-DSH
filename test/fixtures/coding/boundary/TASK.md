# 修复索引边界

修复 `src/index.mjs` 的 `clampIndex(index, length)`。输入为有限数字 index 和非负整数 length；空集合返回 -1，其他情况先将 index 向零取整，再限制到 0 至 length-1。不得修改 package.json 或 check.mjs。

运行 `node check.mjs` 查看公开测试。验收还覆盖空集合、长度 1、负数、小数、超出尾部和已有合法索引；参考解不复制到工作区。
