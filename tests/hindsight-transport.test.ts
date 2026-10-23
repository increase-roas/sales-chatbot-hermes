import assert from 'node:assert/strict'
import { test } from 'node:test'

test('Hindsight runtime uses the current schema and refuses an org-wide key', async () => {
  let api: typeof import('../src/mastra/hindsight-transport.ts')
  try { api = await import('../src/mastra/hindsight-transport.ts') } catch { assert.fail('Hindsight runtime transport missing') }
  const bankId = 'paperclip::f63a396b-956e-42ca-9916-88d98f4a54fe'
  const requests: { path: string; body: unknown }[] = []
  const fakeFetch: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (path.endsWith('/banks')) return Response.json({ banks: [{ bank_id: bankId }] })
    if (path.endsWith('/knowledge-base/tree')) return Response.json({ roots: [{ id: 'folder', kind: 'folder', name: 'Sales', children: [{ id: 'p1', kind: 'page', name: 'Rules' }] }] })
    if (path.endsWith('/knowledge-base/pages/p1')) return Response.json({ id: 'p1', name: 'Rules', markdown: 'Rooflines' })
    if (path.endsWith('/memories/recall')) return Response.json({ results: [{ text: 'Marvin owns quotes' }] })
    return Response.json({ success: true, bank_id: bankId, items_count: 1, async: true, operation_id: 'op-1' })
  }
  const transport = api.createHindsightTransport({ bankId, apiKey: 'fake-fixture-key' }, fakeFetch)
  assert.deepEqual(await transport.listPages(), [{ id: 'p1', name: 'Rules' }])
  assert.equal((await transport.getPage('p1')).content, 'Rooflines')
  assert.equal(await transport.recall('sales rules'), 'Marvin owns quotes')
  await transport.retain({ content: 'Business outcome', documentId: 'doc-1', tags: ['source:mastra'] })
  const last = requests.at(-1)!
  assert.match(last.path, /\/memories$/)
  assert.deepEqual(last.body, { items: [{ content: 'Business outcome', document_id: 'doc-1', context: 'workflow outcome', tags: ['source:mastra'] }], async: true })
  const wide = api.createHindsightTransport({ bankId, apiKey: 'fake-fixture-key' }, async () => Response.json({ banks: [{ bank_id: bankId }, { bank_id: 'alex-agents' }] }))
  await assert.rejects(wide.listPages(), /bank-scoped/)
})
