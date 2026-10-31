import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// 从 dist/test 出发，../../ 是仓库根；.env.example 与 md 只在仓库里，不进 dist。
const repository = fileURLToPath(new URL('../../', import.meta.url))
const read = (name: string) => fs.readFileSync(`${repository}${name}`, 'utf8')

test('.env.example 不含评测专用变量', () => {
    const found = read('.env.example').match(/MINI_DSH_EVAL_[A-Z0-9_]+/g) ?? []
    assert.deepEqual(found, [], '评测变量写在 scripts/eval-screening.ts 页首，不放进普通用户复制的配置模板')
})

test('源码读取的环境变量都在 .env.example 或使用指南中说明', () => {
    const sources: string[] = ['plugins.config.ts']
    const walk = (directory: string) => {
        for (const entry of fs.readdirSync(`${repository}${directory}`, { withFileTypes: true })) {
            const name = `${directory}/${entry.name}`
            if (entry.isDirectory()) walk(name)
            else if (entry.name.endsWith('.ts')) sources.push(name)
        }
    }
    walk('src')
    const variables = new Set(sources.flatMap(name => read(name).match(/\b(?:MINI_DSH|DEEPSEEK)_[A-Z0-9_]+\b/g) ?? []))
    assert.ok(variables.size > 0, 'src 中没有找到环境变量')
    const documented = read('.env.example') + read('docs/USAGE.md')
    const missing = [...variables].filter(name => !documented.includes(name)).sort()
    assert.deepEqual(missing, [], `未在 .env.example 或 docs/USAGE.md 说明：${missing.join(', ')}`)
})
