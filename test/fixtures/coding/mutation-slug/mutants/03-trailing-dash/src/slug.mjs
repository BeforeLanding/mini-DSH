// 把名称规整成可用的 slug。完整规则见 docs/SPEC.md。
export function slugify(name, { fallback = 'untitled', maxLength = 40 } = {}) {
  if (typeof name !== 'string') throw new Error('name must be a string')
  if (typeof fallback !== 'string' || fallback === '') throw new Error('fallback must be a non-empty string')
  if (!Number.isSafeInteger(maxLength) || maxLength <= 0) throw new Error('maxLength must be a positive integer')
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/g, '')
  if (base === '') return fallback
  return base.length > maxLength ? base.slice(0, maxLength).replace(/-+$/, '') : base
}
