// 行为保持的等价实现：先把段补齐成三段再校验，最后用 reduce 逐段折叠出结论。
export function compareVersions(left, right) {
  const a = parse(left)
  const b = parse(right)
  return a.reduce((result, part, index) => (result !== 0 ? result : Math.sign(part - b[index])), 0)
}

function parse(value) {
  if (typeof value !== 'string') throw new Error('versions must be strings')
  const parts = value.split('.')
  if (parts.length > 3) throw new Error(`version must have at most three parts: ${value}`)
  const padded = [...parts, '0', '0'].slice(0, 3)
  return padded.map(part => {
    if (!/^\d+$/.test(part)) throw new Error(`version parts must be non-negative integers: ${value}`)
    return Number(part)
  })
}
