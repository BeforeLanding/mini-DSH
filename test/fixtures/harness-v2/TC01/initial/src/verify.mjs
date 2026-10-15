import { sign } from './signature/hmac.mjs'
import { equalSignature } from './signature/compare.mjs'
import { withinWindow } from './time/window.mjs'
import { newSeen } from './state/seen.mjs'
import { normalize } from './request/normalize.mjs'
export function createVerifier(secret, nowMs) {
  const seen = newSeen()
  return { verify(raw) {
    const request = normalize(raw)
    if (!withinWindow(nowMs, request.at)) return false
    if (!equalSignature(sign(secret, request.id, request.at), request.signature)) return false
    if (seen.has(request.id)) return false
    seen.add(request.id)
    return true
  } }
}
