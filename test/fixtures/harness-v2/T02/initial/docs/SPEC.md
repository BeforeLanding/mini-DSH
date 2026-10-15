# 限额合同

`createLimiter(limit)` 要求非负整数 limit。实例的 `take(amount)` 要求正整数 amount；余额足够则扣减并返回 true，不足返回 false 且状态不变。`remaining()` 返回余额；`reset()` 恢复初始 limit。每个实例互不影响。无效 limit/amount 抛 RangeError。
