import { resolve } from '../eval/resolve.mjs'
export const isEnabled = (name, settings) => resolve(name, settings)
