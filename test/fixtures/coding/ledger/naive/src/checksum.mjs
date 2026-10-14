import { toCents } from './summarize.mjs'

// 只按 SPEC 第 2 节已经写明的口径：金额换算成「分」的整数，带符号求和。
// 这份文件不是参考解，而是「口径没接上时会落成什么样」的对照物——它满足 SPEC 里能读到的每一条，
// 只在会话历史给出的那一条上不同。仅供 test/nx38-covenant.test.ts 使用，不进 initial/ 也不进 reference/。
export function checksum(entries) {
  return entries.reduce((total, entry) => total + toCents(entry.amount), 0)
}
