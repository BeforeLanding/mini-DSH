const entries = new Map()
export const readCache = key => entries.get(key)
export const writeCache = (key, value) => entries.set(key, value)
export const clearCache = () => entries.clear()
