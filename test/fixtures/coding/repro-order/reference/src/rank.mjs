// 把一批选手排成名次表。完整规则见 docs/SPEC.md。
export function rank(players) {
  if (!Array.isArray(players)) throw new Error('players must be an array')
  for (const player of players) {
    if (typeof player.id !== 'string') throw new Error('id must be a string')
    if (!Number.isFinite(player.score)) throw new Error('score must be a finite number')
  }
  return [...players].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
