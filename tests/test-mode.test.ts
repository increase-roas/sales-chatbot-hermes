import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sendApprovedDraft } from '../src/mastra/drafts.ts'
import { isTestPhone, parseRating } from '../src/mastra/test-mode.ts'

test('only listed test numbers are in test mode', () => {
  const env = { BOT_TEST_PHONES: '+1 (555) 010-0001, 5550100002' }
  assert.equal(isTestPhone('+15550100001', env), true)
  assert.equal(isTestPhone('555-010-0002', env), true)
  assert.equal(isTestPhone('+15559999999', env), false)
  assert.equal(isTestPhone('+15550100001', {}), false)
})

test('in-thread ratings', () => {
  assert.deepEqual(parseRating('👍'), { grade: 'approve' })
  assert.deepEqual(parseRating('👎🏽'), { grade: 'reject' })
  assert.deepEqual(parseRating('rate: yep we do rooflines, whats the address?'), { grade: 'edit', editedReply: 'yep we do rooflines, whats the address?' })
  assert.equal(parseRating('yes I want a quote'), null)
  assert.equal(parseRating('good morning'), null)
})

function fakeDb(row: Record<string, unknown> | null) {
  return { none: async () => undefined, any: async () => [], oneOrNone: async () => row } as never
}

test('send is refused when the Jobber quote is approved or Jobber cannot be checked', async () => {
  const row = { contact_id: 'c1', phone: '+15550100', reply: 'hey', media_urls: [] }
  const approved = await sendApprovedDraft(fakeDb(row), 'd1', { enabled: true, apiKey: 'k', jobber: { quoteStatusForPhone: async () => 'approved', createQuote: async () => ({ id: '', url: '' }) } })
  assert.deepEqual(approved, { sent: false, mode: 'draft', reason: 'jobber_quote_approved' })
  const unknown = await sendApprovedDraft(fakeDb(row), 'd1', { enabled: true, apiKey: 'k', jobber: { quoteStatusForPhone: async () => 'unknown', createQuote: async () => ({ id: '', url: '' }) } })
  assert.equal(unknown.reason, 'jobber_status_unknown')
})

test('test-mode send needs the contact phone to match a listed test number', async () => {
  const { testDestinationOk } = await import('../src/mastra/test-mode.ts')
  const env = { BOT_TEST_PHONES: '+15550100001' }
  assert.equal(testDestinationOk('+15550100001', '(555) 010-0001', env), true)
  assert.equal(testDestinationOk('+15550100001', '+15559998888', env), false)
  assert.equal(testDestinationOk('+15559998888', '+15559998888', env), false)
})

test('customers never get a consent-pending photo; the test number can', async () => {
  const { consentedMedia } = await import('../src/mastra/photos.ts')
  const lib = [{ file: 'pending.jpg', consent: 'pending' }, { file: 'ok.jpg', consent: 'granted' }]
  assert.deepEqual(consentedMedia(['https://cdn.example/pending.jpg'], false, lib), [])
  assert.deepEqual(consentedMedia(['https://cdn.example/pending.jpg'], true, lib), ['https://cdn.example/pending.jpg'])
  assert.deepEqual(consentedMedia(['https://cdn.example/ok.jpg'], false, lib), ['https://cdn.example/ok.jpg'])
  assert.deepEqual(consentedMedia(['https://evil.example/x.jpg'], true), [])
})
