# 校准题：把Webhook重放事故写成测试

文件范围：已有文件均不得修改（包括 package.json、源码、规格和公开检查）；交付文件是根目录 `suite.mjs`。

`logs/webhooks.ndjson` 与 `docs/SECURITY.md` 描述签名、时间窗和事件ID重放约束。当前 `createVerifier(secret,nowMs)` 已正确实现，公开 smoke 只覆盖一次有效请求。请新建 `suite.mjs`：在正确及等价实现上通过，让重放、过期时间窗和签名绕过变异体失败。只检查公开 `verify(request)` 的行为，不比对源码文字、哈希或文件名。测试必须确定性运行，不发网络请求。本题与正式T题使用不同项目和事故类型。
