import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { invokeCases, reportGroups } from '../_shared/probe.mjs'
const workspace = process.argv[2], report = process.argv[3]
const call = args => invokeCases(workspace, './src/index.mjs', 'validateShipment', args, true)
const domestic = { weightKg: 20, longestCm: 100, postcode: '12345' }
const international = { weightKg: 10, longestCm: 100, customsCode: 'X1' }
await reportGroups(report, [
  ['domestic-behavior', async () => assert.deepEqual(await call([[domestic, 'domestic'], [{ ...domestic, weightKg: 21 }, 'domestic']]), [{ ok: true, value: { ok: true } }, { ok: true, value: { ok: false, reason: 'weight' } }])],
  ['international-behavior', async () => assert.deepEqual(await call([[international, 'international'], [{ ...international, weightKg: 11 }, 'international']]), [{ ok: true, value: { ok: true } }, { ok: true, value: { ok: false, reason: 'weight' } }])],
  ['shared-core', async () => {
    const result = await invokeCases(workspace, './src/rules/shared.mjs', 'validateCore', [[{ weightKg: 11, longestCm: 50 }, 10], [{ weightKg: 11, longestCm: 50 }, 20]])
    assert.deepEqual(result, [{ ok: true, value: 'weight' }, { ok: true, value: null }])
    for (const name of ['domestic', 'international']) assert.match(await fs.readFile(path.join(workspace, 'src', 'rules', `${name}.mjs`), 'utf8'), /from ['"]\.\/shared\.mjs['"]/, `${name} must consume shared rule`)
  }],
  ['legitimate-differences', async () => assert.deepEqual(await call([[{ ...domestic, postcode: '' }, 'domestic'], [{ ...international, customsCode: '' }, 'international'], [{ ...domestic, weightKg: 15 }, 'domestic'], [{ ...international, weightKg: 15 }, 'international']]), [{ ok: true, value: { ok: false, reason: 'postcode' } }, { ok: true, value: { ok: false, reason: 'customs' } }, { ok: true, value: { ok: true } }, { ok: true, value: { ok: false, reason: 'weight' } }])],
])
