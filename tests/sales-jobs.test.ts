import assert from 'node:assert/strict'
import { test } from 'node:test'

test('Paperclip job boundary rejects unauthenticated, arbitrary and incomplete jobs', async () => {
  let api: typeof import('../src/mastra/sales-jobs.ts')
  try { api = await import('../src/mastra/sales-jobs.ts') } catch { assert.fail('internal sales job boundary missing') }
  assert.equal((await api.handleSalesJob(false, null, { action: 'status' })).status, 401)
  assert.equal((await api.handleSalesJob(true, null, { action: 'send', to: 'someone' })).status, 400)
  assert.equal((await api.handleSalesJob(true, null, { action: 'followups.register', contactId: 'c1' })).status, 400)
  assert.equal((await api.handleSalesJob(true, null, { action: 'status' })).status, 503)
})


test('explicit completion recovery is authenticated and bounded to ten saved intents', async () => {
  const { handleSalesJob } = await import('../src/mastra/sales-jobs.ts')
  let selected = ''
  const db: any = { none: async () => {}, oneOrNone: async () => null, any: async (q: string) => { selected = q; return [] } }
  assert.equal((await handleSalesJob(false, db, { action: 'work.resume' })).status, 401)
  assert.equal((await handleSalesJob(true, db, { action: 'work.resume', limit: 100 })).status, 400)
  const result = await handleSalesJob(true, db, { action: 'work.resume' })
  assert.equal(result.status, 200)
  assert.match(selected, /LIMIT 10/)
  assert.match(selected, /completion_intent/)
})

test('work.resume validates and returns an explicit pagination cursor', async () => {
  const { handleSalesJob } = await import('../src/mastra/sales-jobs.ts')
  const id = '00000000-0000-4000-8000-000000000010'; let cursor: unknown
  const db: any = { none: async () => {}, oneOrNone: async () => null,
    any: async (_q: string, values: unknown[] = []) => { cursor = values[0]; return cursor ? [] : [{ id, completion_intent: null }] } }
  assert.equal((await handleSalesJob(true, db, { action: 'work.resume', afterDraftId: 'invalid' })).status, 400)
  const first = await handleSalesJob(true, db, { action: 'work.resume' })
  assert.equal(first.status, 200); assert.equal(first.body.nextAfterDraftId, id)
  const second = await handleSalesJob(true, db, { action: 'work.resume', afterDraftId: id })
  assert.equal(second.status, 200); assert.equal(cursor, id); assert.equal(second.body.nextAfterDraftId, null)
})
