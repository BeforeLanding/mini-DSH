// 比较两个版本号。完整规则见 docs/SPEC.md。
export function compareVersions(left, right) {
  const parse = value => {
    if (typeof value !== 'string') throw new Error('versions must be strings')
    const parts = value.split('.')
    if (parts.length > 3) throw new Error(`version must have at most three parts: ${value}`)
    if (!parts.every(part => /^\d+$/.test(part))) throw new Error(`version parts must be non-negative integers: ${value}`)
    return [0, 1, 2].map(index => Number(parts[index] ?? 0))
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1
  }
  return 0
}
