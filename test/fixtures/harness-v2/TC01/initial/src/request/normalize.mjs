import { idOf } from './id.mjs'
import { atOf } from './time.mjs'
export const normalize = request => ({ id: idOf(request), at: atOf(request), signature: request.signature })
