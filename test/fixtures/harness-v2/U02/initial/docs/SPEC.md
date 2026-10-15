# Profile 服务

`getProfile({ tenant, id }, transport)` 以租户和 ID 共同标识资源；同一对键重复调用可复用缓存，不同租户绝不能共享内容。`transport({ tenant, id, attempt })` 可为异步函数；第 0 次尝试抛错时至多再试一次。传输成功返回的对象原样交给调用方。`resetProfiles()` 清空缓存。
