export const newState = () => new Map()
export const put = (state, line) => state.set(line.sku, { ...line })
export const drop = (state, sku) => state.delete(sku)
export const lines = state => [...state.values()].map(line => ({ ...line }))
