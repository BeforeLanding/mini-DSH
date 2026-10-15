import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectExit, reportGroups, runCandidate, withVariant } from '../_shared/probe.mjs'
const candidate = process.argv[2], report = process.argv[3]
const source = path.dirname(fileURLToPath(import.meta.url))
const probe = async (variant, code) => withVariant(candidate, variant && path.join(source, variant), async workspace => expectExit(await runCandidate(workspace, 'node suite.mjs'), code))
await reportGroups(report, [
  ['correct-implementation', () => probe(null, 0)],
  ['threshold-mutant', () => probe('mutant-threshold', 1)],
  ['validation-mutant', () => probe('mutant-validation', 1)],
  ['equivalent-implementation', () => probe('equivalent', 0)],
])
