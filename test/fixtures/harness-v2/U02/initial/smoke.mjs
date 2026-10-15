import assert from 'node:assert/strict'
import { getProfile, resetProfiles } from './src/index.mjs'
resetProfiles()
assert.deepEqual(await getProfile({ tenant: 'north', id: '7' }, async ({ tenant, id }) => ({ tenant, id })), { tenant: 'north', id: '7' })
