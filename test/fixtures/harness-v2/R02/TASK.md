# 迁移查找结果接口

文件范围：仅可修改以下已有文件：`src/lookup.mjs`、`src/greeting.mjs`、`src/audit.mjs`、`src/badge.mjs`；其他已有文件（包括 package.json、规格和公开检查）不得修改。

当前 `findUser(store, id)` 返回用户对象或 null。将它迁移为 `{ found: boolean, user: object | null }`，并同步 `greetUser`、`auditUser`、`badgeUser` 三处消费者；旧业务输出保持一致。找不到时三处输出分别为 `Hello stranger`、`missing:<id>`、`-`。仓库输入错误必须原样抛出，不能伪装成“未找到”。只允许修改 `src/lookup.mjs`、`src/greeting.mjs`、`src/audit.mjs`、`src/badge.mjs`；公开 smoke 只验证旧问候。
