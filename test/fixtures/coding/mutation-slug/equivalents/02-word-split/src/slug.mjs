// 行为保持的等价实现：先按「连续的字母数字」切出词，再用单连字符接起来。
// 选项的默认值改用显式判断而不是解构默认值，签名也不同。
export function slugify(name, settings = {}) {
  if (typeof name !== 'string') throw new Error('name must be a string')
  const fallback = settings.fallback === undefined ? 'untitled' : settings.fallback
  const maxLength = settings.maxLength === undefined ? 40 : settings.maxLength
  if (typeof fallback !== 'string' || fallback === '') throw new Error('fallback must be a non-empty string')
  if (!Number.isSafeInteger(maxLength) || maxLength <= 0) throw new Error('maxLength must be a positive integer')
  const base = (name.toLowerCase().match(/[a-z0-9]+/g) ?? []).join('-')
  if (base === '') return fallback
  if (base.length <= maxLength) return base
  const cut = base.slice(0, maxLength)
  return cut.endsWith('-') ? cut.slice(0, -1) : cut
}
