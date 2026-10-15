import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectExit, reportGroups, runCandidate, withVariant } from '../_shared/probe.mjs'
const candidate = process.argv[2], report = process.argv[3], source = path.dirname(fileURLToPath(import.meta.url))
const probe = async (variant, code) => withVariant(candidate, variant && path.join(source, variant), async workspace => expectExit(await runCandidate(workspace, 'node repro.mjs'), code))
await reportGroups(report, [
  ['obsolete-rule-detected', () => probe(null, 1)],
  ['current-rule-accepted', () => probe('reference', 0)],
  ['equivalent-policy-a', () => probe('equivalent-a', 0)],
  ['equivalent-policy-b', () => probe('equivalent-b', 0)],
])
