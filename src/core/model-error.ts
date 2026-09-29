import type { ChatResponse } from './contracts.js'
export class ModelStreamError extends Error {
  constructor(message: string, public partial: ChatResponse, cause?: unknown) { super(message, { cause }) }
}
