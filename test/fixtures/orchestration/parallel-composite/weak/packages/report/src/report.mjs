import { normalizeName } from '../../normalize/src/name.mjs'
import { uniqueById } from '../../dedupe/src/unique.mjs'

// 反例：先去重再列名。公开冒烟检查能通过，但违反“names 为每位输入人员保留一个姓名”。
// 写法取自 batch-01 中 S 臂的真实实现（import 路径改为本夹具的文件布局）。
export function describePeople(people) {
  const uniquePeople = uniqueById(people)
  return {
    names: uniquePeople.map((person) => normalizeName(person.name)),
    count: uniquePeople.length,
  }
}
