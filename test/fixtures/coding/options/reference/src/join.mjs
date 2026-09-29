export function joinWords(words, { separator = ', ', skipEmpty = false } = {}) {
  return (skipEmpty ? words.filter(word => word !== '') : words).join(separator)
}
