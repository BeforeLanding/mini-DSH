# 调度器合同

`createScheduler()` 返回带状态的对象；`enqueue(scheduler,{id,priority})` 加入任务；`cancel(scheduler,id)` 删除；`next(scheduler)` 取出优先级数字最小者，同优先级按先入先出，空队列返回null。终态状态模块内部应是二叉最小堆，旧适配器不再使用。
