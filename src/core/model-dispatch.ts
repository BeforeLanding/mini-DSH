export class ModelNotDispatchedError extends Error {
  constructor(message: string, readonly reason: 'request_limit' | 'amount_limit' | 'usage_unknown' | 'other_limit') {
    super(message)
    this.name = 'ModelNotDispatchedError'
  }
}
