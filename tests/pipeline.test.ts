import assert from 'node:assert/strict'
import { test } from 'node:test'

import { allOpportunities, approvalMatches, batchSha256, dedupeByContact, type Opp } from '../src/mastra/pipeline.ts'

const opp = (i: number, c = `c${i}`): Opp => ({ id: `o${i}`, contactId: c, stageId: 's', status: 'open' })

test('pages through every opportunity and stops on a short or repeated page', async () => {
  const pages: Record<number, Opp[]> = { 1: [opp(1), opp(2)], 2: [opp(3), opp(4)], 3: [opp(5)] }
  assert.equal((await allOpportunities(async p => pages[p] ?? [], 2)).length, 5)
  assert.equal((await allOpportunities(async () => [opp(1), opp(2)], 2)).length, 2)
})

test('one draft per contact', () => {
  assert.deepEqual(dedupeByContact([opp(1, 'a'), opp(2, 'a'), opp(3, 'b'), opp(4, '')]).map(o => o.id), ['o1', 'o3'])
})

test('approval is bound to the exact batch Alex reviewed', () => {
  const text = '{"contactId":"a","reply":"hey"}\n'
  const sha = batchSha256(text)
  assert.equal(approvalMatches(text, sha.slice(0, 12)), true)
  assert.equal(approvalMatches(text + 'x', sha.slice(0, 12)), false)
  assert.equal(approvalMatches(text, sha.slice(0, 6)), false)
})
