export const groupRows = rows => {
  const groups = new Map()
  for (const row of rows) groups.set(row.batch, [...(groups.get(row.batch) ?? []), row])
  return groups
}
