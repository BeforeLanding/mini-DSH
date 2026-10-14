import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// 从 dist/test 出发，../../ 是仓库根；md 只在仓库里、不进 dist（与 docs-links.test.ts 同一约定）。
const repository = fileURLToPath(new URL('../../', import.meta.url))
// CRLF 归一后再分节：本仓库 core.autocrlf 生效，行尾不归一会让按行匹配处处落空。
const source = fs.readFileSync(`${repository}docs/context-budget/NX-08-REPORT.md`, 'utf8').replace(/\r\n?/g, '\n')

// NX-38-1：报告此前只有一层判据——通过率——于是「处理没生效」与「生效了但结局没变」被写成同一句话
// 「无差异」。NX-08f 的对照 B 正是这么被记成「未观测到处理生效」的，而它实际是**仪器未成立**。
// 这里把两件事钉成结构：分层表必须给每一批实验填层 A，且**层 A 不成立的行不得带结局读数**；
// 指标资格表必须逐项写清资格与依据。护栏是结构性的（表形与取值域），不是字符串黑名单——
// 它不检查措辞是否贴切，只检查「结局有没有被挂在一次没有发生的处理上」。
function body(heading: string): string {
    const lines = source.split('\n')
    const start = lines.findIndex(line => /^##\s/.test(line) && line.includes(heading))
    assert.ok(start >= 0, `NX-08-REPORT 缺少「${heading}」一节：层 A／层 B 的读法必须有唯一的一处定义`)
    // `###` 不算分节边界（`/^##\s/` 要求 `##` 后紧跟空白），因此小节标题留在本节正文里。
    const end = lines.slice(start + 1).findIndex(line => /^##\s/.test(line))
    return lines.slice(start + 1, end === -1 ? undefined : start + 1 + end).join('\n')
}

interface Table { header: string[]; rows: string[][] }
// 表头按「行里含某个词」定位，而不按序号：插一列不该让守卫静默地读错列。
function table(section: string, header: string): Table {
    const lines = section.split('\n')
    const head = lines.findIndex(line => line.startsWith('|') && line.includes(header))
    assert.ok(head >= 0, `找不到表头含「${header}」的表`)
    const cells = (line: string) => line.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
    const rows: string[][] = []
    for (let index = head + 2; index < lines.length && lines[index].startsWith('|'); index += 1) rows.push(cells(lines[index]))
    return { header: cells(lines[head]), rows }
}

test('every experiment is read through layer A before layer B, and no outcome is read off a treatment that never fired', () => {
    const layered = table(body('判据分层'), '层 A')
    const layerA = layered.header.indexOf('层 A'), layerB = layered.header.indexOf('层 B')
    // 「层 A 读数」按前缀找而不是按字面找：列名措辞可以改，但它必须是与判定列并列的另一列。
    const reading = layered.header.findIndex(cell => cell.startsWith('层 A') && cell !== '层 A')
    assert.ok(layerA >= 0, '分层表必须有「层 A」这一列')
    assert.ok(layerB >= 0, '分层表必须有「层 B」这一列')
    assert.ok(reading >= 0, '分层表必须有「层 A 读数」这一列：判定要带证据，不能只有结论')
    assert.ok(layered.rows.length >= 4, `分层表只覆盖 ${layered.rows.length} 批实验，本报告有四批`)
    for (const row of layered.rows) {
        assert.ok(row.length >= layered.header.length, `${row[0]} 的列数少于表头，分层表被写坏了`)
        assert.ok(row[layerA], `${row[0]} 没有层 A 判定：结局不能脱离「处理有没有发生」单独成立`)
        assert.ok(row[reading], `${row[0]} 没有层 A 读数：判定「处理是否发生」的那条证据必须落在表里`)
        // NX-08f 的教训逐字落在这里：处理没有发生时，那一行不得记任何结局。
        if (row[layerA].includes('不成立')) assert.equal(row[layerB], '—', `${row[0]} 的层 A 不成立，层 B 必须留空（—），不得记结局`)
    }
})

test('every indicator states its eligibility and reason, and no indicator the treatment itself defines is allowed as an outcome', () => {
    const indicators = table(body('判据分层'), '指标')
    const eligibility = indicators.header.indexOf('资格'), reason = indicators.header.indexOf('依据')
    assert.ok(eligibility >= 0, '资格表必须有「资格」这一列')
    assert.ok(reason >= 0, '资格表必须有「依据」这一列')
    assert.ok(indicators.rows.length >= 5, `资格表只列了 ${indicators.rows.length} 个指标，少于此前的清单`)
    for (const row of indicators.rows) {
        assert.ok(row.length >= indicators.header.length, `${row[0]} 的列数少于表头，资格表被写坏了`)
        const verdict = row[eligibility].replace(/\*/g, '')
        assert.match(verdict, /^(合格|不合格|待判)/, `${row[0]} 的资格必须取 合格／不合格／待判 之一，实际是「${verdict}」`)
        assert.ok(row[reason].length >= 8, `${row[0]} 没有写依据：只给一个标签等于没判`)
        // 判「不合格」的唯一理由是这个量由处理直接定义——不写出这一句，它就与「待判」没有区别。
        if (verdict.startsWith('不合格')) assert.ok(row[reason].includes('处理'), `${row[0]} 判不合格，依据里必须说明它由处理直接定义`)
    }
    // 防止表格被清成空壳：这两个量是判据讨论的固定成员，掉了它们守卫也应当出声。
    const listed = indicators.rows.map(row => row[0]).join(' ')
    for (const required of ['通过率', 'token']) assert.ok(listed.includes(required), `资格表里少了「${required}」`)
})
