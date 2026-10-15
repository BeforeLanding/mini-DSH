import { compare } from '../compare.mjs'
export const newQueue = () => ({ data: [], nextSeq: 0 })
const swap = (data, a, b) => { [data[a], data[b]] = [data[b], data[a]] }
const up = (data, start) => { let index = start; while (index > 0) { const parent = Math.floor((index - 1) / 2); if (compare(data[parent], data[index]) <= 0) break; swap(data, parent, index); index = parent } }
const down = (data, start) => { let index = start; while (true) { const left = index * 2 + 1, right = left + 1; let best = index; if (left < data.length && compare(data[left], data[best]) < 0) best = left; if (right < data.length && compare(data[right], data[best]) < 0) best = right; if (best === index) break; swap(data, index, best); index = best } }
export function push(state, job) { state.data.push({ ...job, seq: state.nextSeq++ }); up(state.data, state.data.length - 1) }
export function pop(state) { if (!state.data.length) return null; const first = state.data[0], last = state.data.pop(); if (state.data.length) { state.data[0] = last; down(state.data, 0) } return first }
export function remove(state, id) { const index = state.data.findIndex(job => job.id === id); if (index < 0) return; const last = state.data.pop(); if (index < state.data.length) { state.data[index] = last; const parent = Math.floor((index - 1) / 2); if (index > 0 && compare(state.data[index], state.data[parent]) < 0) up(state.data, index); else down(state.data, index) } }
