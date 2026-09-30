# retry

retry(operation, maxAttempts) 最多调用异步操作 maxAttempts 次，成功即返回结果；失败后继续尝试，最终失败时抛出最后一次原始错误对象。maxAttempts 为正整数；成功值为 0 时也必须立即停止。评测会在单段请求预算耗尽后继续同一任务：保留已执行检查，只补做被跳过的编辑和后续验证。

运行 `node check.mjs` 查看公开检查。只能修改 `src/`；不得修改 `package.json` 或 `check.mjs`。独立验收覆盖更多输入，参考解不复制到工作区。
