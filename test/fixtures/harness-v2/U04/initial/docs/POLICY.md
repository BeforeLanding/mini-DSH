# 访问策略演进

旧规则：访客可读公开资源；员工可读内部资源并可导出；管理员可执行所有动作。EU内部导出后来增加限制，曾短暂通过 legacyToken 豁免。当前合同以最后一次任务变更为准。请求字段为 `{role, resource, action, region, legacyToken, migrationGrant}`，`canAccess` 返回布尔值。
