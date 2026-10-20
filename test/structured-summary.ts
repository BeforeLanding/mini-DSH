// A compact synthetic provider response that satisfies the production summary contract.
export function structuredSummary(work: string) {
  return ['## Primary Request', 'Continue the current task.', '## Completed Work', work,
    '## Pending Work', 'Continue from the saved state.', '## Key Evidence', 'Original session events are retained.'].join('\n')
}
