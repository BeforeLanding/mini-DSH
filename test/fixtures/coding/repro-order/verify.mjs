// 判据本体住在 ../_shared/criteria.mjs：两个新种类的判据只有那一份实现，因此门禁测试能直接对它跑
// 正例与反例，而不必为每个 fixture 重写一套复制与运行的逻辑。
import { verifyCriteria } from '../_shared/criteria.mjs'
await verifyCriteria(import.meta.url)
