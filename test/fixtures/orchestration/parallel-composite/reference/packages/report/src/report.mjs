import { normalizeName } from '../../normalize/src/name.mjs'
import { uniqueById } from '../../dedupe/src/unique.mjs'

export function describePeople(people) {
  return { names: people.map(person => normalizeName(person.name)), count: uniqueById(people).length }
}
