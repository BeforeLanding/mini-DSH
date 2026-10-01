// `initial/data/records.jsonl` 的生成器。数据集是 NX-08f 的仪器：它是「原始字段 + 数据集给出的期望规范值」
// 的金标数据，`src/normalize.mjs` 的规整结果必须逐条等于 `expected`，`report.mjs` 把不一致项逐条打印出来。
// 用确定性 LCG 而不是 Math.random，重跑同一条命令得到逐字节相同的文件；记录数、取值池与缺陷比例都写在这里，
// 调仪器规模时改这一个文件再重跑，不要把生成出来的 200 KB 当成手写产物。
//
//   node test/fixtures/coding/audit/generate.mjs
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 记录数决定数据集体积与「报告输出有多大」的上限：每条记录最多贡献一条 name 违规和一条 email 违规。
// 1600 条让数据文件约 200 KB（模型可以用有限的几次有界读取看完），而完整报告约 1 MB（远远超过输入目标）。
const COUNT = 1600
const SEED = 20261001

const FIRST = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'karl', 'linda', 'mallory', 'niaj', 'olivia', 'peggy', 'quentin', 'rupert', 'sybil', 'trent', 'uma', 'victor', 'wendy', 'xavier', 'yolanda', 'zach']
const LAST = ['smith', 'jones', 'brown', 'miller', 'wilson', 'moore', 'taylor', 'anderson', 'thomas', 'jackson', 'white', 'harris', 'martin', 'thompson', 'garcia', 'martinez', 'robinson', 'clark', 'rodriguez', 'lewis']
const DOMAIN = ['acme.example', 'globex.example', 'initech.example', 'umbrella.example', 'hooli.example']

// 确定性伪随机：只用于挑名字/域名/金额，不用于决定缺陷——缺陷由下面的模数规则决定，便于按比例推算规模。
function lcg(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

const random = lcg(SEED)
const pick = pool => pool[Math.floor(random() * pool.length)]

// 三条缺陷轴，比例互质以便重叠部分可推算（判定条件都是「规整结果 ≠ expected」，与原始值是否已经规范无关）：
//   i % 3 === 0  → name 带首尾空白与内部连续空白（需要 trim + 折叠），约 1/3
//   i % 7 < 2    → email 大写（需要小写化），约 2/7
//   i % 2 === 0  → 金额取一位小数，规范形式因此以 0 结尾（"275.10"）；规整器一旦用 String(Number(v))
//                  就会把这个 0 吃掉。奇数条取两位小数，于是 amount 只是一条子集轴而不是恒违规。
const lines = []
for (let index = 0; index < COUNT; index += 1) {
  const id = `r${String(index + 1).padStart(4, '0')}`
  const first = pick(FIRST), last = pick(LAST), domain = pick(DOMAIN)
  const canonicalName = `${first} ${last}`
  const canonicalEmail = `${first}.${last}@${domain}`
  const amount = index % 2 === 0 ? (Math.floor(random() * 9000) + 1000) / 10 : (Math.floor(random() * 90000) + 1000) / 100
  const name = index % 3 === 0 ? `  ${first}   ${last}  ` : canonicalName
  const email = index % 7 < 2 ? canonicalEmail.toUpperCase() : canonicalEmail
  lines.push(JSON.stringify({
    id, name, email, amount: String(amount),
    expected: { name: canonicalName, email: canonicalEmail, amount: amount.toFixed(2) },
  }))
}

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), 'initial', 'data', 'records.jsonl')
await fs.mkdir(path.dirname(target), { recursive: true })
await fs.writeFile(target, `${lines.join('\n')}\n`)
console.log(`${target}: ${lines.length} 条，${Buffer.byteLength(lines.join('\n'))} 字节`)
