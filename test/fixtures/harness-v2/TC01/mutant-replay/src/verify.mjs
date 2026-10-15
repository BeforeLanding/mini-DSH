import { sign } from './signature/hmac.mjs'
import { equalSignature } from './signature/compare.mjs'
import { withinWindow } from './time/window.mjs'
import { normalize } from './request/normalize.mjs'
export function createVerifier(secret, nowMs) { return { verify(raw) { const request = normalize(raw); return withinWindow(nowMs, request.at) && equalSignature(sign(secret, request.id, request.at), request.signature) } } }
