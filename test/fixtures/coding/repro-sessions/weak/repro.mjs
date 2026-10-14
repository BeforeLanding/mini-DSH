// 反例产物：它只检查两种实现都满足的性质，因此在原始缺陷上**也**退出 0——FAIL_TO_PASS 判不过。
// 它的存在是为了让门禁能在离线状态下钉住「这个判据不是白送的」：判据若退化成「能跑就行」，这条会变绿。
import { groupSessions } from './src/sessions.mjs'

if (JSON.stringify(groupSessions([5, 5], 1000)) !== '[[5,5]]') {
  process.stderr.write('同一个时间戳相邻时应当属于同一会话\n')
  process.exit(1)
}
