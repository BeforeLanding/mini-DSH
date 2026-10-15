import { pageSlice } from './page.mjs'
export const paginate = (items, page, size) => pageSlice(items, page, size)
