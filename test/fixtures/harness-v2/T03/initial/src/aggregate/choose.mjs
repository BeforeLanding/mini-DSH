import { rank } from '../event/severity.mjs'
export const newer = (left, right) => right.at > left.at || (right.at === left.at && rank(right.severity) > rank(left.severity)) ? right : left
