import { compare } from '../compare.mjs'
export const newQueue = () => ({ data: [], nextSeq: 0 })
export const push = (state, job) => { state.data.push({ ...job, seq: state.nextSeq++ }); state.data.sort(compare) }
export const pop = state => state.data.shift() ?? null
export const remove = () => {}
