// 行为保持的等价实现：先找出第一个不同的段，再比较那一段；全等则是 0。
export function compareVersions(left, right) {
  const a = parse(left)
  const b = parse(right)
  const index = a.findIndex((part, position) => part !== b[position])
  if (index === -1) return 0
  return a[index] > b[index] ? 1 : -1
}

function parse(value) {
  if (typeof value !== 'string') throw new Error('versions must be strings')
  const parts = value.split('.')
  if (parts.length > 3) throw new Error(`version must have at most three parts: ${value}`)
  if (parts.some(part => !/^\d+$/.test(part))) throw new Error(`version parts must be non-negative integers: ${value}`)
  return [0, 1, 2].map(index => Number(parts[index] ?? 0))
}
