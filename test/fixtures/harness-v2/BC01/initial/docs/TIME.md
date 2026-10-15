# 时间归属

每个事件有 ISO UTC `at`。本地时间=UTC+`offsetMinutes`，可跨前一日或后一日。分组键为本地 `YYYY-MM-DD`，返回 `{day,count}`，按day升序；事件数组不修改。offset按分钟，可正可负。
