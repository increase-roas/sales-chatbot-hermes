import test from 'node:test'
import assert from 'node:assert/strict'
import { runDurableEffect } from '../src/mastra/durable-work.ts'

export class TestStore {
  rows = new Map<string, any>()
  async enqueue(input: any) { if (!this.rows.has(input.source_key)) this.rows.set(input.source_key, { ...input, status: 'pending', receipt: null }); return this.get(input.source_key) }
  async get(key: string) { return this.rows.get(key) ?? null }
  async claim(key: string) { const row = this.rows.get(key); if (!row || row.status !== 'pending') return null; row.status = 'dispatching'; return { ...row } }
  async finish(key: string, status: string, receipt: any = null) { Object.assign(this.rows.get(key), { status, receipt }); return this.get(key) }
  async defer(key: string, due: Date) { Object.assign(this.rows.get(key), { status: 'pending', due_at: due }); return this.get(key) }
  async due(now: Date, limit: number) { return [...this.rows.values()].filter(r => r.kind === 'quote_followup' && r.status === 'pending' && new Date(r.due_at) <= now).slice(0, limit) }
}
const item = { source_key: 'handoff:c1:m1:task', kind: 'handoff', contact_id: 'c1', due_at: new Date('2026-10-22T16:00:00Z'), payload: {} }

test('durable handoff concurrent/restarted calls reuse the persisted receipt', async () => {
  const store = new TestStore(); let calls = 0
  const dispatch = async () => { calls++; return { providerId: 'task-1' } }
  await Promise.all([runDurableEffect(store, item, dispatch), runDurableEffect(store, item, dispatch)])
  const replay = await runDurableEffect(store, item, dispatch)
  assert.equal(calls, 1); assert.equal(replay.status, 'completed'); assert.equal(replay.receipt.providerId, 'task-1')
})
test('missing acknowledgement and timeout become uncertain and never retry blindly', async () => {
  for (const dispatch of [async () => ({ providerId: '' }), async () => { throw new Error('timeout') }]) {
    const store = new TestStore(); let calls = 0
    const effect = async () => { calls++; return dispatch() }
    assert.equal((await runDurableEffect(store, item, effect)).status, 'uncertain')
    assert.equal((await runDurableEffect(store, item, effect)).status, 'uncertain'); assert.equal(calls, 1)
  }
})
test('an interrupted dispatch stays held and completed earlier steps survive later uncertainty', async () => {
  const store = new TestStore(); await store.enqueue(item); await store.claim(item.source_key)
  let calls = 0
  assert.equal((await runDurableEffect(store, item, async () => { calls++; return { providerId: 'bad' } })).status, 'dispatching')
  assert.equal(calls, 0)
  const second = { ...item, source_key: 'handoff:c1:m1:quote' }
  await runDurableEffect(store, second, async () => ({ providerId: 'q1' }))
  assert.equal((await store.get(second.source_key)).receipt.providerId, 'q1')
})

test('quote flow reuses completed task receipt through the journal across invocations', async () => {
  const { runQuoteRequestedFlow } = await import('../src/mastra/quote-flow.ts')
  const store = new TestStore(); let calls = 0
  const deps = { ghl: { createTask: async () => { calls++; return { id: 't1' } } } as any, jobber: null,
    access: async () => ({ allowed: true }), switches: { tag: false, jobberQuote: false, marvinTask: true }, journal: { store, conversationId: 'confirmed-m1' } }
  const req = { contactId: 'c1', name: 'Lead', phone: '', address: 'house' }
  const first = await runQuoteRequestedFlow(req, deps)
  const second = await runQuoteRequestedFlow(req, deps)
  assert.equal(calls, 1); assert.equal(first[2].detail, 't1'); assert.equal(second[2].detail, 't1')
})

test('tag completion requires authoritative tag readback', async () => {
  const { runQuoteRequestedFlow } = await import('../src/mastra/quote-flow.ts')
  const store = new TestStore(); let posts = 0
  const deps = { ghl: { addTags: async () => { posts++ }, getContact: async () => ({ id: 'c1', tags: ['quote requested'] }) } as any,
    access: async () => ({ allowed: true }), jobber: null, switches: { tag: true, jobberQuote: false, marvinTask: false }, journal: { store, conversationId: 'm1' } }
  const result = await runQuoteRequestedFlow({ contactId: 'c1', name: '', phone: '', address: '' }, deps)
  assert.equal(result[0].done, true); assert.equal(result[0].detail, 'c1:quote requested'); assert.equal(posts, 1)
})
test('dispatch intent exists before call and only proven not-sent failures may retry', async () => {
  const { KnownNotSentError } = await import('../src/mastra/durable-work.ts')
  const store = new TestStore(); let calls = 0
  const dispatch = async () => {
    assert.equal((await store.get(item.source_key)).status, 'dispatching'); calls++
    if (calls === 1) throw new KnownNotSentError('validation rejected before transport')
    return { providerId: 't2' }
  }
  assert.equal((await runDurableEffect(store, item, dispatch)).status, 'pending')
  assert.equal((await runDurableEffect(store, item, dispatch)).status, 'completed'); assert.equal(calls, 2)
})
