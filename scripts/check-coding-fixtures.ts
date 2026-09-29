import { createFixture, fixtureIds } from './coding-fixtures.js'

let failed = false
for (const id of fixtureIds) {
  const fixture = await createFixture(id)
  try {
    const initial = await fixture.evaluate()
    await fixture.applyReference()
    const reference = await fixture.evaluate()
    const expected = !initial.passed && initial.exitCode === 1 && reference.passed
    failed ||= !expected
    console.log(JSON.stringify({ fixture: id, initial, reference, expected }))
  } finally { await fixture.close() }
}
if (failed) process.exitCode = 1
