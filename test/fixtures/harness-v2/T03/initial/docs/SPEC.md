# 告警合并

输入事件为 `{tenant,id,at,severity}`。同一 `(tenant,id)` 只保留 `at` 最大的一条；同时间戳取 `severity` 高者（low < medium < high）。不同租户同ID必须各自保留。返回 `{tenant,id,at,severity}` 数组，按 tenant 然后 id 字典序排列。输入不允许被修改，空输入返回空数组。
