import test from 'node:test'
import assert from 'node:assert/strict'
import { scheduleQuoteFollowups, runDueQuoteFollowups } from '../src/mastra/followup-runner.ts'
// State survives construction of a new caller, standing in for the database boundary.
class Store {
  rows = new Map<string, any>()
  async enqueue(i: any) { if (!this.rows.has(i.source_key)) this.rows.set(i.source_key, { ...i, status: 'pending', receipt: null }); return this.get(i.source_key) }
  async get(k: string) { return this.rows.get(k) ?? null }
  async claim(k: string) { const r = this.rows.get(k); if (!r || r.status !== 'pending') return null; r.status = 'dispatching'; return { ...r } }
  async finish(k: string, status: string, receipt: any = null) { Object.assign(this.rows.get(k), { status, receipt }); return this.get(k) }
  async defer(k: string, due_at: Date) { Object.assign(this.rows.get(k), { status: 'pending', due_at }); return this.get(k) }
  async due(now: Date, limit: number) { return [...this.rows.values()].filter(r => r.kind === 'quote_followup' && r.status === 'pending' && new Date(r.due_at) <= now).slice(0, limit) }
}
const sent = new Date('2026-10-21T16:00:00Z')
const now = new Date('2026-10-22T16:00:00Z')
const fresh = () => ({ optedOut: false, owner: 'bot' as const, identityResolved: true, quoteRef: 'q1', state: { quoteSentAt: sent, approved: false, linesSent: [], photosSent: [] } })
async function setup() { const store = new Store(); await scheduleQuoteFollowups(store, { contactId: 'c1', quoteRef: 'q1', quoteSentAt: sent }); return store }
test('schedule keeps the approved four due dates and deduplicates', async () => {
  const store = await setup(); await scheduleQuoteFollowups(store, { contactId: 'c1', quoteRef: 'q1', quoteSentAt: sent })
  assert.equal(store.rows.size, 4)
  assert.deepEqual([...store.rows.values()].map(r => new Date(r.due_at).toISOString()), ['2026-10-22T16:00:00.000Z', '2026-10-23T16:00:00.000Z', '2026-10-25T16:00:00.000Z', '2026-10-28T16:00:00.000Z'])
})
test('concurrent runners draft once using durable identity; completed replay does not redraft', async () => {
  const store = await setup(); const keys: string[] = []
  const deps = { readCurrent: async () => fresh(), prepareDraft: async (i: any) => { keys.push(i.messageId); return { draftId: 'd1' } } }
  await Promise.all([runDueQuoteFollowups(store, deps, now), runDueQuoteFollowups(store, deps, now)])
  await runDueQuoteFollowups(store, deps, now)
  assert.deepEqual(keys, ['followup:c1:q1:1']); assert.equal([...store.rows.values()][0].receipt.draftId, 'd1')
})
test('fresh STOP, takeover, reply, approved quote or unresolved identity cancels without drafting', async () => {
  for (const patch of [{ optedOut: true }, { owner: 'human' }, { identityResolved: false }, { quoteRef: 'q2' }, { state: { ...fresh().state, approved: true } }, { state: { ...fresh().state, customerRepliedSince: true } }]) {
    const store = await setup(); let calls = 0
    await runDueQuoteFollowups(store, { readCurrent: async () => ({ ...fresh(), ...patch }), prepareDraft: async () => { calls++; return { draftId: 'd1' } } }, now)
    assert.equal(calls, 0); assert.equal([...store.rows.values()][0].status, 'cancelled')
  }
})
test('quiet hours defer and ambiguous draft errors hold instead of recreating', async () => {
  const store = await setup(); let calls = 0
  const deps = { readCurrent: async () => fresh(), prepareDraft: async () => { calls++; throw new Error('ack lost') } }
  await runDueQuoteFollowups(store, deps, new Date('2026-10-23T02:00:00Z'))
  assert.equal(calls, 0); assert.equal([...store.rows.values()][0].status, 'pending')
  await runDueQuoteFollowups(store, deps, new Date('2026-10-23T16:00:00Z'))
  assert.equal(calls, 1); assert.equal([...store.rows.values()][0].status, 'uncertain')
})
test('an uncertain predecessor cancels its later chain with a reconciliation receipt and no repeated provider reads', async () => {
  const store = await setup()
  const first = 'followup:c1:q1:1'
  await store.claim(first); await store.finish(first, 'uncertain', { reason: 'draft_requires_readback' })
  let reads = 0, drafts = 0
  const deps = { readCurrent: async () => { reads++; return fresh() }, prepareDraft: async () => { drafts++; return { draftId: 'never' } } }
  await runDueQuoteFollowups(store, deps, new Date('2026-10-29T16:00:00Z'))
  assert.equal(reads, 0); assert.equal(drafts, 0)
  for (const sequence of [2, 3, 4]) {
    const row = await store.get(`followup:c1:q1:${sequence}`)
    assert.equal(row.status, 'cancelled')
    assert.equal(row.receipt.reason, 'prior_followup_requires_reconciliation')
    assert.equal(row.receipt.predecessor, first)
  }
  await runDueQuoteFollowups(store, deps, new Date('2026-10-30T16:00:00Z'))
  assert.equal(reads, 0); assert.equal((await store.get(first)).status, 'uncertain')
})
