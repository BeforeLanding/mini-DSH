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

// 模型评测只发布 SWE-bench 一项：README 写到结果时，同一节里必须同时有成本、逐项消融的限制与结果页链接，
// 不允许只摘出分数。展示面的美元金额、分数表与“提升/成功率+数字”句式仍由上一条用例拦截。
test('README 的评测结论连同成本、限制与结果页一起出现', () => {
    const section = read('README.md').split('\n## ').find(part => part.startsWith('评测\n'))
    assert.ok(section, 'README 缺少“评测”一节')
    assert.match(section, /\]\(docs\/SWE-BENCH-RESULTS\.md\)/, '评测一节须链接结果页')
    assert.match(section, /成本/, '评测一节须写成本')
    assert.match(section, /逐项消融/, '评测一节须写未做逐项消融')
})

test('SWE-bench 结果页写明设置、题目划分、检验、成本与限制', () => {
    const page = read('docs/SWE-BENCH-RESULTS.md')
    for (const required of ['deepseek/deepseek-flash', '题目划分', 'McNemar', '不显著', '## 限制', '成本', '逐项消融', '默认关闭']) {
        assert.ok(page.includes(required), `SWE-BENCH-RESULTS.md 缺少：${required}`)
    }
})

test('内部路线图不出现在 README 与文档索引的链接里', () => {
    assert.equal(read('README.md').includes('INTERNSHIP_ROADMAP'), false, 'README 不应链接内部路线图')
    assert.equal(read('docs/README.md').includes('INTERNSHIP_ROADMAP'), false, 'docs/README 不应链接内部路线图')
})

test('证据文档写明不是能力分数', () => {
    assert.match(read('docs/EVALUATION-SWEBENCH.md'), /展示边界|不展示模型评测结果|不是能力分数/)
    assert.match(read('docs/COMPONENT-OPTIMIZATION.md'), /不证明.*成功率|not a capability/i)
})
