# 订单金额

每项 `unitCents*quantity` 求原价。优惠券最多减到0，折后净额为 `baseCents-couponCents`；A区税率10%，B区5%，按折后净额四舍五入求税，退款 `refundCents` 已为负分值，最终总额=净额+税+退款。返回 `{netCents,taxCents,totalCents}`。无优惠无退款行为也必须保持。
