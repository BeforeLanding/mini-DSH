import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 从 dist/test 出发，../../ 是仓库根；docs/ 只在仓库里，不进 dist。
const repository = fileURLToPath(new URL('../../', import.meta.url))
const document = path.join(repository, 'docs', 'context-budget', 'DECISIONS.md')
const plan = path.join(repository, 'docs', 'context-budget', 'PLAN.md')

// 路线图 M9 点名要求解释的五条选择。少一条就算这份文档没有交付它该交付的东西。
const topics = ['事件与投影分离', '协议完整性', '可靠编辑', '验证时效', '未知副作用恢复']
// 判定「它钉住什么」一列里的 token 是否离锚点太远。行号会漂——文件上面插几行，锚点就指到
// 别的函数上去了，而截图看不出来。
const proximity = 5

const text = (target: string) => fs.readFileSync(target, 'utf8').replace(/\r\n?/g, '\n')
const tokensIn = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map(match => match[1])

interface Row { section: string | undefined; kind: string; anchor: string; note: string }

// 只认表格行，不解析散文：正文里提到某个文件不会因此被当成锚点。
function parse(source: string): { rows: Row[]; sections: string[] } {
    const rows: Row[] = []
    const sections: string[] = []
    // 只认三级标题为节；`#### 锚点` 这样的小标题不切换节，但它上面的二级标题（如结尾总表）
    // 会离开节，使落在那里的锚点行被判为越界。
    let section: string | undefined
    for (const line of source.split('\n')) {
        const title = /^(#{1,6})\s+(\S.*)$/.exec(line)
        if (title) {
            const level = title[1].length
            if (level === 3) { section = title[2].trim(); sections.push(section) }
            else if (level < 3) section = undefined
            continue
        }
        const row = /^\|\s*(代码|测试)\s*\|/.exec(line)
        if (!row) continue
        const cells = line.split('|')
        rows.push({ section, kind: row[1], anchor: cells[2] ?? '', note: cells[3] ?? '' })
    }
    return { rows, sections }
}

// 节标题 → 该节正文（到下一条三级或更高级标题为止）。切节口径与上面的 parse() 一致：
// `#### 锚点` 这类四级小标题不切节，它下面的正文仍属于本节。
function bodies(source: string): { title: string; body: string }[] {
    const out: { title: string; body: string }[] = []
    let title: string | undefined
    let body: string[] = []
    for (const line of source.split('\n')) {
        const heading = /^(#{1,6})\s+(\S.*)$/.exec(line)
        if (heading) {
            const level = heading[1].length
            if (level <= 3) {
                if (title !== undefined) out.push({ title, body: body.join('\n') })
                title = level === 3 ? heading[2].trim() : undefined
                body = []
            }
            continue
        }
        if (title !== undefined) body.push(line)
    }
    if (title !== undefined) out.push({ title, body: body.join('\n') })
    return out
}

// PLAN 的决策小节标题形如 `### D-21 当前任务历史的可回读压缩（NX-34）`。正文第一行以
// 「修订」开头的，就是一份改掉了既有决策的决策；它后头写的 D-xx 就是被改的那些。
function planRevisions(source: string): { reviser: string; revised: string[] }[] {
    const out: { reviser: string; revised: string[] }[] = []
    let current: { id: string; body: string[] } | undefined
    const flush = () => {
        if (current === undefined) return
        const first = current.body.find(line => line.trim() !== '') ?? ''
        if (first.startsWith('修订')) {
            const revised = [...new Set([...first.matchAll(/D-\d+/g)].map(match => match[0]))]
            if (revised.length > 0) out.push({ reviser: current.id, revised })
        }
        current = undefined
    }
    for (const line of source.split('\n')) {
        const heading = /^(#{1,6})\s+(\S.*)$/.exec(line)
        if (heading) {
            const level = heading[1].length
            if (level <= 3) {
                flush()
                const id = level === 3 ? /^(D-\d+)\b/.exec(heading[2]) : null
                current = id ? { id: id[1], body: [] } : undefined
            }
            continue
        }
        if (current !== undefined) current.body.push(line)
    }
    flush()
    return out
}

// 这份文档的价值全在「锚点是真的」，所以这里把「还指着真东西」变成回归。
// 它证明不了那个测试确实断言了文中的话——邻近检查是位置检查，不是语义证明。
test('the decision write-up keeps every code and test anchor pointing at something real', () => {
    const source = text(document)
    const { rows, sections } = parse(source)
    const problems: string[] = []
    const codeRows = rows.filter(row => row.kind === '代码')
    const testRows = rows.filter(row => row.kind === '测试')

    for (const topic of topics) if (!sections.some(title => title.includes(topic))) problems.push(`缺少小节：${topic}`)
    for (const row of rows) if (row.section === undefined) problems.push(`锚点行落在小节之外：${row.anchor.trim()}`)
    for (const title of sections) {
        if (!codeRows.some(row => row.section === title)) problems.push(`小节没有代码锚点：${title}`)
        if (!testRows.some(row => row.section === title)) problems.push(`小节没有测试锚点：${title}`)
    }

    for (const row of codeRows) {
        const tokens = tokensIn(row.anchor)
        const target = tokens[0] ?? ''
        const match = /^([\w./-]+\.(?:ts|js|mjs)):(\d+)$/.exec(target)
        if (!match) { problems.push(`代码锚点格式不对：${target || '(空)'}`); continue }
        const file = path.join(repository, match[1])
        if (!fs.existsSync(file)) { problems.push(`代码锚点指向不存在的文件：${match[1]}`); continue }
        const lines = text(file).split('\n')
        const line = Number(match[2])
        if (line < 1 || line > lines.length) { problems.push(`代码锚点行号越界：${target}（该文件 ${lines.length} 行）`); continue }
        const pinned = tokensIn(row.note)[0]
        if (pinned === undefined) continue
        const window = lines.slice(Math.max(0, line - 1 - proximity), line + proximity)
        if (!window.some(item => item.includes(pinned))) problems.push(`锚点与说明对不上：${target} 附近 ${proximity} 行内找不到 \`${pinned}\``)
    }

    for (const row of testRows) {
        const [file, name] = tokensIn(row.anchor)
        if (!file || !name) { problems.push(`测试锚点缺少文件或测试名：${row.anchor.trim()}`); continue }
        const target = path.join(repository, file)
        if (!fs.existsSync(target)) { problems.push(`测试锚点指向不存在的文件：${file}`); continue }
        if (!text(target).includes(name)) problems.push(`测试锚点找不到该用例：${file} · ${name}`)
    }

    assert.deepEqual(problems, [])
    assert.ok(codeRows.length >= topics.length, '代码锚点数量不应少于小节数')
    assert.ok(testRows.length >= topics.length, '测试锚点数量不应少于小节数')
})

// PLAN 里凡以「修订 D-xx」开头的决策，都改掉了本文某一节援引的结论。那一节必须留下反转
// 注记并点出修订者的编号——否则读者读到的是已经被推翻、却没人告诉他被推翻的说法。
// 2026-10-06 的 NX-35 发现 §1 仍写着「没有 compaction」就漏在这一步：NX-34 改过这个文件，
// 但只重编了行号，而上面那条锚点回归对散文一句话都不问。
// 和锚点一样，这条只钉「有没有承认被改过」，不证明注记把改动说对了。
test('every PLAN revision of a decision the write-up cites is acknowledged in that section', () => {
    const revisions = planRevisions(text(plan))
    // 这条护栏由 PLAN 的「修订」前缀驱动。前缀若换写法，护栏会静默变成空转——先把非空钉住。
    assert.ok(revisions.length > 0, 'PLAN 里没有解析到任何以「修订」开头的决策，本条护栏已空转')

    const problems: string[] = []
    for (const { reviser, revised } of revisions) {
        for (const { title, body } of bodies(text(document))) {
            const declared = /规范条目见\s*\[PLAN 的 ([^\]]+)\]/.exec(body)?.[1] ?? ''
            const cited = [...declared.matchAll(/D-\d+/g)].map(match => match[0])
            if (!cited.some(id => revised.includes(id))) continue
            if (!body.includes(reviser)) problems.push(`「${title}」援引的 ${cited.join('／')} 已被 ${reviser} 修订，本节却没有点出 ${reviser}`)
        }
    }
    assert.deepEqual(problems, [])
})
