import assert from 'node:assert/strict'
import { test } from 'node:test'

test('a followup requires a sent quote and stops after a fresh customer reply', async () => {
  let api: typeof import('../src/mastra/followup-runtime.ts')
  try { api = await import('../src/mastra/followup-runtime.ts') } catch { assert.fail('followup runtime not connected') }
  const quoteSentAt = new Date('2026-10-21T16:00:00Z')
  assert.equal(api.hasReplyAfterQuote([{ role: 'user', text: 'yes', at: '2026-10-21T17:00:00Z' }], quoteSentAt), true)
  assert.equal(api.hasReplyAfterQuote([{ role: 'assistant', text: 'quote', at: '2026-10-21T17:00:00Z' }, { role: 'user', text: 'yes', at: '2026-10-20T17:00:00Z' }], quoteSentAt), false)
  assert.throws(() => api.hasReplyAfterQuote([{ role: 'user', text: 'yes', at: 'invalid' }], quoteSentAt), /timestamp/)
})
