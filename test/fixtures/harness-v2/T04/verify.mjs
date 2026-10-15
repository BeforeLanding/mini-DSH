import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectExit, reportGroups, runCandidate, withVariant } from '../_shared/probe.mjs'
const candidate = process.argv[2], report = process.argv[3], source = path.dirname(fileURLToPath(import.meta.url))
const probe = async (variant, code) => withVariant(candidate, variant && path.join(source, variant), async workspace => expectExit(await runCandidate(workspace, 'node suite.mjs'), code))
await reportGroups(report, [
  ['retired-rule-rejected', () => probe(null, 1)],
  ['current-rule-accepted', () => probe('reference', 0)],
  ['two-regression-mutants', async () => withVariant(candidate, path.join(source, 'reference'), async current => {
    for (const mutant of ['mutant-threshold', 'mutant-exemption']) await withVariant(current, path.join(source, mutant), async workspace => expectExit(await runCandidate(workspace, 'node suite.mjs'), 1))
  })],
  ['equivalent-current-rule', async () => withVariant(candidate, path.join(source, 'reference'), async workspace => withVariant(workspace, path.join(source, 'equivalent'), async equivalent => expectExit(await runCandidate(equivalent, 'node suite.mjs'), 0)))],
])
