# 报表合同

`createReport()` 的 `add` 接收字符串 id/account 和整数分值；`snapshot()` 按账户字典序返回新数组；全局事件ID去重，之后同账户金额累加；`exportCsv()` 输出排序后的完整表格，表头和末尾换行固定。公开 smoke 只测试空报表。
