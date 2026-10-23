import test from 'node:test'
import assert from 'node:assert/strict'
import { ghlClient } from '../src/mastra/ghl.ts'
import { hasReplyAfterQuote } from '../src/mastra/followup-runtime.ts'

test('supported attachment-only inbound messages retain empty text, direction, channel and timestamp', async () => {
  const messages = [
    { id: 'photo', direction: 'inbound', messageType: 'SMS', body: '', dateAdded: '2026-10-21T17:00:00Z', attachments: ['https://example.test/house.jpg'] },
    { id: 'ig-photo', direction: 'inbound', messageType: 'IG', dateAdded: '2026-10-21T18:00:00Z', attachments: ['https://example.test/ig.jpg'] },
    { id: 'text', direction: 'outbound', messageType: 'FACEBOOK', body: 'quote sent', dateAdded: '2026-10-21T16:00:00Z' },
    { id: 'call', direction: 'inbound', messageType: 'TYPE_CALL', body: 'call', dateAdded: '2026-10-21T19:00:00Z' },
  ]
  const client = ghlClient('offline', 'https://example.test', async url => new Response(JSON.stringify(String(url).includes('/messages?') ? { messages: { messages } } : { conversations: [{ id: 'conversation' }] })))!
  const thread = await client.getThread('contact')
  assert.deepEqual(thread, [
    { id: 'text', role: 'assistant', text: 'quote sent', at: '2026-10-21T16:00:00Z', channel: 'FACEBOOK', direction: 'outbound' },
    { id: 'photo', role: 'user', text: '', at: '2026-10-21T17:00:00Z', channel: 'SMS', direction: 'inbound' },
    { id: 'ig-photo', role: 'user', text: '', at: '2026-10-21T18:00:00Z', channel: 'IG', direction: 'inbound' },
  ])
  assert.equal(hasReplyAfterQuote(thread, new Date('2026-10-21T16:00:00Z')), true)
})
