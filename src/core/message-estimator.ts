import type { Message } from './contracts.js'
import { estimateText } from './token-estimator.js'
export function estimateMessage(message: Message) { return 32 + estimateText(JSON.stringify(message)) }
