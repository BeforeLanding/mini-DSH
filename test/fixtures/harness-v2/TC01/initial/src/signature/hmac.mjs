import { createHmac } from 'node:crypto'
export const sign = (secret, id, at) => createHmac('sha256', secret).update(`${id}:${at}`).digest('hex')
