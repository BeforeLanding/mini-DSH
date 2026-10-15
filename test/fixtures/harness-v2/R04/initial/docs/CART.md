# 购物车合同

`createCart()` 创建独立状态；`addItem(cart,sku,priceCents,quantity)` 替换同sku行，`removeItem(cart,sku)` 删除；`checkout(cart)` 返回金额分值和，`badge(cart)` 返回数量和，`summary(cart)` 返回按sku字典序排列的新行数组。最后状态模块应以 Map 保存行，旧 legacy 适配器不再被生产代码引用。输入对象不能被修改。
