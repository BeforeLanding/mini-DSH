import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 从 dist/test 出发，../../ 是仓库根；md 只在仓库里，不进 dist。
const repository = fileURLToPath(new URL('../../', import.meta.url))
// 这些目录里的 md 不是仓库文档：`dist` 是产物，其余是本地运行痕迹或依赖。
const skipped = new Set(['node_modules', '.git', 'dist', '.demo-runs', '.eval-evidence'])

const text = (target: string) => fs.readFileSync(target, 'utf8').replace(/\r\n?/g, '\n')

// GitHub 的标题锚点规则（github-slugger v2）：小写 → 去掉标点与符号 → **每个字面空格各换一个
// `-`**。空格不折叠是关键：`a — b` 得到的 slug 是 `a--b`，按 `\s+ → -` 折叠会把这类正确的
// 双连字符链接误报成坏的。`-` 与 `_` 属于「会被保留」的那一组，不能随标点一起删。
const keep = new Set(['-', '_'])
function slug(title: string): string {
    return title.toLowerCase()
        .replace(/[\p{P}\p{S}]/gu, character => (keep.has(character) ? character : ''))
        .replace(/ /g, '-')
}

// 同一标题出现两次时 GitHub 追加 `-1`、`-2`…，这里照做，否则重复标题会互相顶掉。
function anchorsOf(source: string): Set<string> {
    const used = new Map<string, number>()
    const anchors = new Set<string>()
    for (const line of source.split('\n')) {
        const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)
        if (!heading) continue
        const base = slug(heading[1])
        const seen = used.get(base) ?? 0
        used.set(base, seen + 1)
        anchors.add(seen === 0 ? base : `${base}-${seen}`)
    }
    return anchors
}

interface Link { line: number; target: string }

// 两处都不能省：① 目标里的空格要收进来——锚点写成 `[x](PLAN.md#nx-08 预注册)` 这种带字面空格
// 的坏链接正是本测试要找的东西，用 `[^()\s]+` 会把它静默跳过；② 反引号内的内容在 GitHub 上是
// 代码不是链接，在 `…` 里引用一个坏链接是**说明**它而不是**使用**它，先剥掉代码段再匹配。
function linksIn(source: string): Link[] {
    return source.split('\n').flatMap((line, index) =>
        [...line.replace(/`[^`]*`/g, '').matchAll(/\]\(([^()]+)\)/g)].map(match => ({ line: index + 1, target: match[1] })))
}

function markdownFiles(directory: string, found: string[] = []): string[] {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (skipped.has(entry.name)) continue
        const full = path.join(directory, entry.name)
        if (entry.isDirectory()) markdownFiles(full, found)
        else if (entry.name.endsWith('.md')) found.push(full)
    }
    return found
}

const relative = (target: string) => path.relative(repository, target).replace(/\\/g, '/')

// 锚点坏掉时点击只会停在页首，肉眼扫不出来——NX-22 登记的 6 处就是这么漏掉的。这里把
// 「每个仓库内锚点都指着真标题」变成回归；它不检查锚点**语义**是否贴切，只检查它存不存在。
test('every in-repository markdown anchor points at a real heading', () => {
    const problems: string[] = []
    const anchors = new Map<string, Set<string>>()
    let checked = 0

    for (const file of markdownFiles(repository)) {
        for (const link of linksIn(text(file))) {
            const hash = link.target.indexOf('#')
            if (hash === -1) continue
            const filePart = link.target.slice(0, hash)
            const anchor = link.target.slice(hash + 1)
            // 外链、以及 `#` 后面为空的链接都不在检查范围内。
            if (/^[a-z][a-z0-9+.-]*:/i.test(filePart)) continue
            if (anchor === '') continue
            const target = filePart === '' ? file : path.resolve(path.dirname(file), filePart)
            // 只校验 md 内部锚点；指向源码、图片等的相对链接由别处保证。
            if (filePart !== '' && !filePart.endsWith('.md')) continue
            const where = `${relative(file)}:${link.line}`
            if (!fs.existsSync(target)) { problems.push(`${where} 指向不存在的文件：${filePart}`); continue }
            if (!anchors.has(target)) anchors.set(target, anchorsOf(text(target)))
            checked += 1
            if (!anchors.get(target)!.has(anchor)) problems.push(`${where} 锚点在 ${relative(target)} 中不存在：${anchor}`)
        }
    }

    assert.deepEqual(problems, [])
    // 防止「一个都没扫到」也能通过。当前全仓有 160 余条带锚点的仓库内链接。
    assert.ok(checked >= 120, `扫到的带锚点链接异常地少：${checked}`)
})
