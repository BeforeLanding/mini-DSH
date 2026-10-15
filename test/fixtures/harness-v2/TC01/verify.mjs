import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectExit, reportGroups, runCandidate, withVariant } from '../_shared/probe.mjs'
const candidate = process.argv[2], report = process.argv[3], source = path.dirname(fileURLToPath(import.meta.url))
const probe = async (variant, code) => withVariant(candidate, variant && path.join(source, variant), async workspace => expectExit(await runCandidate(workspace, 'node suite.mjs'), code))
await reportGroups(report, [
  ['correct-webhook-flow', () => probe(null, 0)],
  ['replay-mutant', () => probe('mutant-replay', 1)],
  ['time-and-signature-mutants', async () => { await probe('mutant-time', 1); await probe('mutant-signature', 1) }],
  ['equivalent-verifier', () => probe('equivalent', 0)],
])
