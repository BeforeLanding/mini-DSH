import { compare } from '../compare.mjs'
export const newQueue = () => ({ jobs: [], nextSeq: 0 })
export const push = (state, job) => { state.jobs.push({ ...job, seq: state.nextSeq++ }) }
export const pop = state => { state.jobs.sort(compare); return state.jobs.shift() ?? null }
export const remove = (state, id) => { state.jobs = state.jobs.filter(job => job.id !== id) }
