export const retryable = error => error?.code === 'TEMPORARY'
export const abortError = () => Object.assign(new Error('cancelled'), { name: 'AbortError' })
