# retry

retry(operation, maxAttempts) 最多调用异步操作 maxAttempts 次，成功即返回结果；失败后继续尝试，最终失败时抛出最后一次原始错误。maxAttempts 为正整数。

运行 `node check.mjs` 查看公开检查。只能修改 `src/`；不得修改 `package.json` 或 `check.mjs`。独立验收覆盖更多输入，参考解不复制到工作区。
