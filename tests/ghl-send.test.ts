import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { sendDraftToGhl } from '../src/mastra/ghl-send.ts'

test('sending is off by default', async () => {
  delete process.env.GHL_SEND_ENABLED
  assert.deepEqual(await sendDraftToGhl({ contactId: 'c1', reply: 'hi', mediaUrls: [] }), {
    sent: false, reason: 'sending is off (GHL_SEND_ENABLED is not true)',
  })
})

test('sends the exact GHL body with one attachment to a local stand-in server', async () => {
  const seen: { method?: string; url?: string; headers?: Record<string, unknown>; body?: unknown } = {}
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => (raw += chunk))
    req.on('end', () => {
      Object.assign(seen, { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(raw) })
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ messageId: 'm-test' }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  try {
    const out = await sendDraftToGhl(
      { contactId: 'contact-1', reply: 'here is warm white', mediaUrls: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'] },
      { enabled: true, apiKey: 'test-key', baseUrl: `http://127.0.0.1:${port}` },
    )
    assert.deepEqual(out, { sent: true, status: 201, messageId: 'm-test' })
    assert.equal(seen.method, 'POST')
    assert.equal(seen.url, '/conversations/messages')
    assert.equal(seen.headers?.authorization, 'Bearer test-key')
    assert.equal(seen.headers?.version, '2021-04-15')
    assert.deepEqual(seen.body, { type: 'SMS', contactId: 'contact-1', message: 'here is warm white', attachments: ['https://cdn.example/a.jpg'] })
  } finally {
    server.close()
  }
})
