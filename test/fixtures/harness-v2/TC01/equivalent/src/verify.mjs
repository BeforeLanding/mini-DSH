import { sign } from './signature/hmac.mjs'
import { equalSignature } from './signature/compare.mjs'
import { withinWindow } from './time/window.mjs'
import { normalize } from './request/normalize.mjs'
export function createVerifier(secret, nowMs) {
  const accepted = new Map()
  return { verify(raw) {
    const request = normalize(raw)
    const valid = withinWindow(nowMs, request.at) && equalSignature(sign(secret, request.id, request.at), request.signature)
    if (!valid || accepted.get(request.id)) return false
    accepted.set(request.id, true)
    return true
  } }
}
