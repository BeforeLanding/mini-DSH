import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// 从 dist/test 出发，../../ 是仓库根；md 只在仓库里，不进 dist。
const repository = fileURLToPath(new URL('../../', import.meta.url))
const read = (name: string) => fs.readFileSync(`${repository}${name}`, 'utf8').replace(/\r\n?/g, '\n')

// PROGRESS 只维护当前状态，最容易在后续文档提交里被遗忘；这里只挡两类可机械判定的漂移。

test('PROGRESS 的更新日期不早于 CHANGES 最新条目', () => {
    const updated = read('PROGRESS.md').match(/^更新：(\d{4}-\d{2}-\d{2})/m)?.[1]
    assert.ok(updated, 'PROGRESS.md 缺少“更新：YYYY-MM-DD”行')
    const dates = [...read('docs/context-budget/CHANGES.md').matchAll(/^###.*$/gm)]
        .flatMap(([heading]) => heading.match(/\d{4}-\d{2}-\d{2}/g) ?? [])
    assert.ok(dates.length > 0, 'CHANGES.md 没有带日期的条目')
    const latest = dates.reduce((a, b) => (a > b ? a : b))
    assert.ok(updated >= latest, `PROGRESS 更新于 ${updated}，早于 CHANGES 最新条目 ${latest}；核对当前状态后再改日期`)
})

test('README 已嵌入演示图时 PROGRESS 不再写演示录制暂缓', () => {
    if (!/!\[[^\]]*\]\(docs\/images\/demo-[^)]+\)/.test(read('README.md'))) return
    assert.equal(/演示录制[^。\n]{0,8}暂缓/.test(read('PROGRESS.md')), false, 'README 已有演示图，PROGRESS 仍写“演示录制暂缓”')
})

test('文档里的 Release 链接版本与 package.json 一致', () => {
    const { version } = JSON.parse(read('package.json')) as { version: string }
    const docs = ['README.md', 'PROGRESS.md', 'docs/USAGE.md', 'docs/RECRUITER_WALKTHROUGH.md']
    const links = docs.flatMap(doc => [...read(doc).matchAll(/releases\/tag\/v([0-9][\w.-]*)/g)].map(match => ({ doc, tag: match[1] })))
    assert.ok(links.some(link => link.doc === 'README.md'), 'README 应链接当前版本的 Release')
    const stale = links.filter(link => link.tag !== version).map(link => `${link.doc}: v${link.tag}`)
    assert.deepEqual(stale, [], `Release 链接与 package.json 版本 ${version} 不一致`)
})
