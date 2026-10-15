export const newState = () => []
export const put = (state, line) => { const index = state.findIndex(entry => entry.sku === line.sku); if (index >= 0) state.splice(index, 1); state.push({ ...line }) }
export const drop = (state, sku) => { const index = state.findIndex(entry => entry.sku === sku); if (index >= 0) state.splice(index, 1) }
export const lines = state => state.map(line => ({ ...line }))
