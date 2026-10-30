import test from 'node:test'
import assert from 'node:assert/strict'
import { BATCH_TITLE, MANIFEST_SHA256, verifyAttempt, verifyHistory } from './swe-development-gate.mjs'

test('only the explicit reviewed first dispatch can enter the paid stage', () => {
  const environment = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ATTEMPT: '1', SWE_APPROVED_MANIFEST: MANIFEST_SHA256 }
  verifyAttempt(environment)
  assert.throws(() => verifyAttempt({ ...environment, GITHUB_RUN_ATTEMPT: '2' }), /first-attempt/)
  assert.throws(() => verifyAttempt({ ...environment, GITHUB_EVENT_NAME: 'pull_request' }), /first-attempt/)
  assert.throws(() => verifyAttempt({ ...environment, SWE_APPROVED_MANIFEST: '0'.repeat(64) }), /manifest hash/)
})

test('any prior or concurrent paid dispatch blocks duplicate spending, including a cancelled one', () => {
  verifyHistory([{ id: 123, display_title: BATCH_TITLE }, { id: 122, display_title: 'CI' }], '123')
  assert.throws(() => verifyHistory([{ id: 122, display_title: BATCH_TITLE, conclusion: 'cancelled' }], '123'), /already has/)
  assert.throws(() => verifyHistory([{ id: 124, display_title: BATCH_TITLE, status: 'queued' }], '123'), /already has/)
})
