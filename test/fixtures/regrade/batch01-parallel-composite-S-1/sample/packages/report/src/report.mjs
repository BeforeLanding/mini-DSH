import { uniqueById } from '../../dedupe/index.mjs'
import { normalizeName } from '../../normalize/index.mjs'

export function describePeople(people) {
  const uniquePeople = uniqueById(people)
  return {
    names: uniquePeople.map((person) => normalizeName(person.name)),
    count: uniquePeople.length,
  }
}
