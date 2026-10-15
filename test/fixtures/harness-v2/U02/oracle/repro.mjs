import assert from 'node:assert/strict'
import { getProfile, resetProfiles } from './src/index.mjs'
resetProfiles()
const attempts = new Map()
const transport = async ({ tenant, id, attempt }) => {
  attempts.set(tenant, (attempts.get(tenant) ?? 0) + 1)
  if (tenant === 'north' && attempt === 0) throw Object.assign(new Error('transient'), { code: 'TEMPORARY' })
  return { tenant, id, value: `${tenant}/${id}` }
}
const north = await getProfile({ tenant: 'north', id: '7' }, transport)
const south = await getProfile({ tenant: 'south', id: '7' }, transport)
assert.deepEqual(north, { tenant: 'north', id: '7', value: 'north/7' })
assert.deepEqual(south, { tenant: 'south', id: '7', value: 'south/7' })
assert.equal(attempts.get('north'), 2)
assert.equal(attempts.get('south'), 1)
