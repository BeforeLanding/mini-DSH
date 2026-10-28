import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// 从 dist/test 出发，../../ 是仓库根；md 只在仓库里，不进 dist。
const repository = fileURLToPath(new URL('../../', import.meta.url))
const read = (name: string) => fs.readFileSync(`${repository}${name}`, 'utf8').replace(/\r\n?/g, '\n')

// 展示面 = 招聘者默认会打开的两页；证据文档与内部路线图不在此列。
const displayDocs = ['README.md', 'docs/RECRUITER_WALKTHROUGH.md']

test('展示面不含未决占位语', () => {
    for (const doc of displayDocs) {
        const source = read(doc)
        assert.equal(source.includes('待确认'), false, `${doc} 仍含“待确认”`)
        assert.equal(source.includes('个人负责范围'), false, `${doc} 仍含“个人负责范围”`)
    }
})

test('展示面不展示模型评测分数与费用', () => {
    for (const doc of displayDocs) {
        const source = read(doc)
        assert.equal(/\$\s?\d/.test(source), false, `${doc} 出现美元金额`)
        assert.equal(/^\|.*\|\s*\d+\s*\/\s*\d+\s*\|/m.test(source), false, `${doc} 出现 x/y 形式的分数表`)
        assert.equal(/(提升|成功率|完成率)[^。\n]{0,12}\d/.test(source), false, `${doc} 出现结果百分比结论`)
    }
})

test('README 保留“不展示模型评测结果”的边界声明', () => {
    assert.match(read('README.md'), /不展示模型评测结果/)
})

test('内部路线图不出现在 README 与文档索引的链接里', () => {
    assert.equal(read('README.md').includes('INTERNSHIP_ROADMAP'), false, 'README 不应链接内部路线图')
    assert.equal(read('docs/README.md').includes('INTERNSHIP_ROADMAP'), false, 'docs/README 不应链接内部路线图')
})

test('证据文档写明不是能力分数', () => {
    assert.match(read('docs/EVALUATION-SWEBENCH.md'), /展示边界|不展示模型评测结果|不是能力分数/)
    assert.match(read('docs/COMPONENT-OPTIMIZATION.md'), /不证明.*成功率|not a capability/i)
})
