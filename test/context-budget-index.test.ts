import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// 从 dist/test 出发，../../ 是仓库根；md 与脚本源码只在仓库里，不进 dist。
const repository = fileURLToPath(new URL('../../', import.meta.url))
const read = (name: string) => fs.readFileSync(`${repository}${name}`, 'utf8').replace(/\r\n?/g, '\n')
const index = read('docs/context-budget/README.md')

test('context-budget 目录说明列出目录里的每个文件', () => {
    const files = fs.readdirSync(`${repository}docs/context-budget`).filter(name => name !== 'README.md')
    const missing = files.filter(name => !index.includes(`](${name})`))
    assert.deepEqual(missing, [], `docs/context-budget/README.md 未列出：${missing.join(', ')}`)
})

test('冻结清单引用的文档都列在协议文档一节', () => {
    const section = index.split('\n## ').find(part => part.startsWith('被冻结清单引用的协议文档'))
    assert.ok(section, 'README 缺少“被冻结清单引用的协议文档”一节')
    const pinned = [...new Set([...read('scripts/eval-v2-report.ts').matchAll(/docs\/context-budget\/([\w.-]+\.md)/g)].map(match => match[1]))]
    assert.ok(pinned.length > 0, 'eval-v2-report.ts 中没有找到冻结的 context-budget 文档')
    const missing = pinned.filter(name => !section.includes(`](${name})`))
    assert.deepEqual(missing, [], `冻结文档未列入协议一节：${missing.join(', ')}`)
})
