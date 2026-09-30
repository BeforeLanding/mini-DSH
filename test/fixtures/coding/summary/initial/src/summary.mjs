export function summarize(events) {
  return events.map(event => ({ category: event.category, count: 1, total: event.amount }))
}
