import { assertEvidenceRootUnused, parseV2Arguments, resolveV2Plan } from './eval-v2-plan.js'

// The V2 entry is intentionally read-only until the episode runner and fixture suite have passed
// their independent acceptance steps. A non-plan invocation fails before any file or model work.
const options = parseV2Arguments(process.argv.slice(2))
assertEvidenceRootUnused(options.evidenceRoot)
if (!options.planOnly) throw new Error('NX-42 execution is not available yet; run with --plan-only')
console.log(JSON.stringify(resolveV2Plan(options), null, 2))
