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
