import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { guardReply, stripDashes } from '../src/mastra/guard.ts'

const cases = JSON.parse(readFileSync(new URL('./dash-cases.json', import.meta.url), 'utf8')) as [string, string][]

for (const [input, expected] of cases) {
  test(`stripDashes: ${JSON.stringify(input)}`, () => {
    assert.equal(stripDashes(input), expected)
  })
}

test('no em dash, en dash or spaced hyphen survives the guard', () => {
  const out = guardReply('ok', 'Awesome — could you send a photo – front of the house - thanks').reply
  assert.doesNotMatch(out, /[–—]|\s-\s/)
  assert.equal(out, 'Awesome, could you send a photo, front of the house, thanks')
})

test('guard flags the dash rewrite', () => {
  assert.deepEqual(guardReply('ok', 'Sure — sending now').blocked, ['dash'])
  assert.deepEqual(guardReply('ok', 'Sure, sending now').blocked, [])
})
