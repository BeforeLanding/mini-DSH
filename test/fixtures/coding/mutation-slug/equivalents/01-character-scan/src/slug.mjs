// 行为保持的等价实现：一个字符一个字符地扫，用 `pendingSeparator` 决定要不要补连字符——
// 完全没有正则，分段逻辑与工作区里那份也不同。
const ALNUM = /^[a-z0-9]$/

export function slugify(name, options = {}) {
  if (typeof name !== 'string') throw new Error('name must be a string')
  const fallback = options.fallback === undefined ? 'untitled' : options.fallback
  const maxLength = options.maxLength === undefined ? 40 : options.maxLength
  if (typeof fallback !== 'string' || fallback === '') throw new Error('fallback must be a non-empty string')
  if (!Number.isSafeInteger(maxLength) || maxLength <= 0) throw new Error('maxLength must be a positive integer')
  const kept = []
  let pendingSeparator = false
  for (const character of name.toLowerCase()) {
    if (ALNUM.test(character)) {
      if (pendingSeparator && kept.length > 0) kept.push('-')
      pendingSeparator = false
      kept.push(character)
    } else {
      pendingSeparator = true
    }
  }
  const base = kept.join('')
  if (base === '') return fallback
  if (base.length <= maxLength) return base
  const cut = base.slice(0, maxLength)
  return cut.endsWith('-') ? cut.slice(0, -1) : cut
}
