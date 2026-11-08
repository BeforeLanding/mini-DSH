import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// 隐藏验收器：工作区里没有副本。第三个子任务必须在第二波次读取前两个包的真实实现，
// 因此这里的期望值同时检查「跨包 import 正确」与「依赖产物已整合」。
const workspace = process.argv[2]
const { describePeople } = await import(pathToFileURL(path.join(workspace, 'src/report.mjs')).href)
const cases = [
  [[], { names: [], count: 0 }],
  [[{ id: 1, name: '  Ada   Lovelace  ' }], { names: ['ada lovelace'], count: 1 }],
  [[{ id: 1, name: ' Ada ' }, { id: 1, name: 'Ada Lovelace' }, { id: 2, name: 'Grace\tHopper' }],
    { names: ['ada', 'ada lovelace', 'grace hopper'], count: 2 }],
]
for (const [people, expected] of cases) assert.deepEqual(describePeople(people), expected, `describePeople(${JSON.stringify(people)})`)
console.log('acceptance passed: report')
