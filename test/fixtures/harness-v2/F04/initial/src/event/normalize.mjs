import { eventId } from './id.mjs'
import { accountOf } from './account.mjs'
import { amountOf } from './amount.mjs'
export const normalize = event => ({ id: eventId(event), account: accountOf(event), amountCents: amountOf(event) })
