export function summarize(events) {
  const groups = new Map()
  for (const event of events) {
    const group = groups.get(event.category) ?? { category: event.category, count: 0, total: 0 }
    group.count++
    group.total += event.amount
    groups.set(event.category, group)
  }
  return [...groups.values()].sort((a, b) => a.category.localeCompare(b.category))
}
