// New experiments own their configuration; NX-50 remains a historical contract.
export const componentLooProtocol = Object.freeze({
  id: 'NX-51-component-loo-v1',
  split: 'component-loo',
  gateVersion: 'nx51-component-loo-descriptive-v1',
  scheduleSeed: 20261026,
  repeats: 2,
  episodes: 12,
  threshold: 0.05,
  qualityTolerance: 1,
  postCompactionPrune: false,
  // Execution order is part of this protocol, independent of NX-50 new-first.
  batchOrder: Object.freeze(['full', 'no-preview', 'no-projection', 'no-report'] as const),
  sourcePaths: Object.freeze({
    full: Object.freeze([] as string[]),
    'no-preview': Object.freeze(['src/core/tool-result-store.ts', 'src/plugins/tool-results.ts']),
    'no-projection': Object.freeze(['src/core/compaction-plan.ts']),
    'no-report': Object.freeze(['src/core/file-edit.ts', 'src/core/task-changes.ts', 'src/core/task-verification.ts']),
  }),
})
