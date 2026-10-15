# 迁移查找结果接口

当前 `findUser(store, id)` 返回用户对象或 null。将它迁移为 `{ found: boolean, user: object | null }`，并同步 `greetUser`、`auditUser`、`badgeUser` 三处消费者；旧业务输出保持一致。找不到时三处输出分别为 `Hello stranger`、`missing:<id>`、`-`。仓库输入错误必须原样抛出，不能伪装成“未找到”。只允许修改 `src/lookup.mjs`、`src/greeting.mjs`、`src/audit.mjs`、`src/badge.mjs`；公开 smoke 只验证旧问候。
