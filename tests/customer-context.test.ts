import assert from 'node:assert/strict'
import { test } from 'node:test'

// Import dynamically so the first failure describes the missing behavior rather than test discovery.
test('knowledge from completed work reaches the next startup without customer PII', async () => {
  let api: typeof import('../src/mastra/customer-context.ts')
  try { api = await import('../src/mastra/customer-context.ts') } catch { assert.fail('company knowledge lifecycle is not implemented') }
  const companyId = 'f63a396b-956e-42ca-9916-88d98f4a54fe'
  const calls: string[] = []
  let learned = false
  const transport = {
    listPages: async () => [{ id: 'sales-playbook', name: 'Sales playbook' }],
    getPage: async () => { calls.push('page'); return { id: 'sales-playbook', name: 'Sales playbook', content: learned ? 'Quote handoff completed' : 'Rooflines are the core offer' } },
    recall: async () => { calls.push('recall'); return 'Do not promise dates' },
    retain: async (document: { content: string; documentId: string }) => { calls.push('retain'); assert.match(document.documentId, /^sales:[a-f0-9]{64}$/); assert.doesNotMatch(document.content, /Alice|555|Oak|@/); learned = true; return { operationId: 'op-1' } },
  }
  const lifecycle = api.createCustomerContext({ companyId, bankId: `paperclip::${companyId}`, pageIds: ['sales-playbook'] }, transport)
  const first = await lifecycle.start('sales-rules')
  assert.match(first.text, /Rooflines/)
  await lifecycle.complete({ eventId: 'event-1', outcome: 'quote_requested', dealState: 'CONFIRMED', photoUsed: true })
  const next = await lifecycle.start('sales-rules')
  assert.match(next.text, /Quote handoff completed/)
  assert.deepEqual(calls, ['page', 'recall', 'retain', 'page', 'recall'])
  assert.throws(() => api.createCustomerContext({ companyId, bankId: 'alex-agents', pageIds: [] }, transport), /bank/)
  await assert.rejects(lifecycle.complete({ eventId: 'event-2', outcome: 'quote_requested', dealState: 'CONFIRMED', photoUsed: false, transcript: 'Alice at 10 Oak St' } as never), /field/)
})

test('disabled memory preserves current behavior and enabled memory requires the exact customer', async () => {
  const { customerContextFromEnv } = await import('../src/mastra/customer-context-runtime.ts')
  assert.equal(customerContextFromEnv({}), null)
  assert.throws(() => customerContextFromEnv({ HINDSIGHT_ENABLED: 'true', PAPERCLIP_COMPANY_ID: 'wrong' }), /company/)
})
