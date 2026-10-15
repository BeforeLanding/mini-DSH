import { review, allow } from './labels.mjs'
export const labelFor = flag => flag ? review : allow
