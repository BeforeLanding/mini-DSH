import { isAdmin } from '../roles/admin.mjs'
import { isStaff } from '../roles/staff.mjs'
import { isGuest } from '../roles/guest.mjs'
import { isPublic } from '../resources/public.mjs'
import { isInternal } from '../resources/internal.mjs'
import { isRead } from '../actions/read.mjs'
export function decide(request) {
  if (isAdmin(request)) return true
  if (isGuest(request)) return isPublic(request) && isRead(request)
  if (isStaff(request)) return isInternal(request) || isPublic(request)
  return false
}
