import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectExit, reportGroups, runCandidate, withVariant } from '../_shared/probe.mjs'
const candidate = process.argv[2], report = process.argv[3], source = path.dirname(fileURLToPath(import.meta.url))
const probe = async (variant, code) => withVariant(candidate, variant && path.join(source, variant), async workspace => expectExit(await runCandidate(workspace, 'node suite.mjs'), code))
await reportGroups(report, [
  ['correct-state-machine', () => probe(null, 0)],
  ['capacity-mutant', () => probe('mutant-capacity', 1)],
  ['reset-and-rejection-mutants', async () => { await probe('mutant-reset', 1); await probe('mutant-validation', 1) }],
  ['equivalent-state-machine', () => probe('equivalent', 0)],
])
