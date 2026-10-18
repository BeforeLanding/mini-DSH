# 校准题：本地日界线聚合

文件范围：仅可修改以下已有文件：`src/day.mjs`；其他已有文件（包括 package.json、规格和公开检查）不得修改。

`logs/events.ndjson` 是多地区同一UTC时段的事件流，`docs/TIME.md` 定义本地日归属。`groupEvents(events,offsetMinutes)` 应先将UTC时间加偏移分钟，再按本地日计数并按日期升序输出。现有实现把UTC日期直接作为分组键，午夜附近错误。只改 `src/day.mjs`；普通日、正负偏移、空输入都要保持合同。允许正常搜索与聚合日志，无需照固定路径读完全部日志。本题只供校准，不与正式B题共享项目或缺陷。
