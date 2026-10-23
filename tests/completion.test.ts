import test from 'node:test'
import assert from 'node:assert/strict'
import { resumeDraftCompletion } from '../src/mastra/draft-completion.ts'
import { TestStore } from './durable-work.test.ts'

const req = { contactId: 'c1', name: '', phone: '+13135550123', address: '10 Oak Ave' }
const outcome = { eventId: 'm1', outcome: 'quote_requested', dealState: 'CONFIRMED', photoUsed: false } as const
function fixture() {
  let intent: any = { status: 'pending', handoff: req, memory: outcome }
  const db: any = { none: async () => {}, any: async () => [], oneOrNone: async (_q: string, values: any[]) => { intent = values[1]; return { id: 'd1', completion_intent: intent } } }
  return { db, row: () => ({ id: 'd1', completion_intent: intent }), store: new TestStore() }
}
test('saved completion survives failure, replay and restart with child receipts preserved', async () => {
  const f = fixture(); let tasks = 0, retains = 0
  const deps: any = { store: f.store, ghl: { createTask: async () => { tasks++; return { id: 't1' } } }, jobber: null,
    switches: { tag: false, jobberQuote: false, marvinTask: true }, access: async () => ({ allowed: true }),
    knowledge: { complete: async () => { retains++; return { operationId: 'r1' } } } }
  const persist = f.db.oneOrNone; let fail = true
  f.db.oneOrNone = async (...args: any[]) => { if (fail) { fail = false; throw Error('crash after effects') }; return persist(...args) }
  await assert.rejects(resumeDraftCompletion(f.db, f.row(), deps), /crash/)
  const result = await resumeDraftCompletion(f.db, f.row(), deps)
  assert.equal(result.status, 'completed'); assert.equal(tasks, 1); assert.equal(retains, 1)
  assert.equal((await resumeDraftCompletion(f.db, f.row(), deps)).status, 'completed')
})
test('fresh ownership before each provider effect holds remaining work and STOP remains cancelled', async () => {
  const f = fixture(); let allowed = true, quotes = 0
  const deps: any = { store: f.store, ghl: { addTags: async () => { allowed = false }, getContact: async () => ({ id: 'c1', tags: ['quote requested'] }) },
    jobber: { createQuote: async () => { quotes++; return { id: 'q1' } } }, switches: { tag: true, jobberQuote: true, marvinTask: false },
    access: async () => ({ allowed, reason: 'opt_out' }), knowledge: null }
  const result = await resumeDraftCompletion(f.db, f.row(), deps)
  assert.equal(result.status, 'cancelled'); assert.equal(quotes, 0)
  allowed = true
  assert.equal((await resumeDraftCompletion(f.db, f.row(), deps)).status, 'cancelled'); assert.equal(quotes, 0)
})
test('uncertain child memory receipt never repeats on replay', async () => {
  const f = fixture(); delete f.row().completion_intent.handoff; let calls = 0
  const deps: any = { store: f.store, ghl: null, jobber: null, switches: { tag: false, jobberQuote: false, marvinTask: false }, access: async () => ({ allowed: true }), knowledge: { complete: async () => { calls++; throw Error('timeout') } } }
  assert.equal((await resumeDraftCompletion(f.db, f.row(), deps)).status, 'uncertain')
  assert.equal((await resumeDraftCompletion(f.db, f.row(), deps)).status, 'uncertain'); assert.equal(calls, 1)
})

test('interruption between handoff steps keeps first receipt and resumes later steps', async () => {
  const f = fixture(); let tags = 0, quotes = 0, checks = 0, fail = true
  const deps: any = { store: f.store, ghl: { addTags: async () => { tags++ }, getContact: async () => ({ id: 'c1', tags: ['quote requested'] }) },
    jobber: { createQuote: async () => { quotes++; return { id: 'q1', url: 'quote-url' } } }, switches: { tag: true, jobberQuote: true, marvinTask: false },
    access: async () => { checks++; if (checks === 2 && fail) { fail = false; throw Error('process interrupted') }; return { allowed: true } }, knowledge: { complete: async () => ({ operationId: 'r1' }) } }
  await assert.rejects(resumeDraftCompletion(f.db, f.row(), deps), /interrupted/)
  assert.equal(tags, 1); assert.equal(quotes, 0)
  const result = await resumeDraftCompletion(f.db, f.row(), deps)
  assert.equal(result.status, 'completed'); assert.equal(tags, 1); assert.equal(quotes, 1)
  assert.equal([...f.store.rows.values()].filter(r => r.status === 'completed').length, 3)
})

test('enabled handoff with missing client stays held and resumes once dependency returns', async () => {
  const f = fixture(); delete f.row().completion_intent.memory
  let tasks = 0
  const deps: any = { store: f.store, ghl: null, jobber: null, switches: { tag: false, jobberQuote: false, marvinTask: true }, access: async () => ({ allowed: true }) }
  const held = await resumeDraftCompletion(f.db, f.row(), deps)
  assert.equal(held.status, 'held'); assert.equal(held.reason, 'GHL client unavailable'); assert.equal(f.store.rows.size, 0)
  deps.ghl = { createTask: async () => { tasks++; return { id: 't1' } } }
  assert.equal((await resumeDraftCompletion(f.db, f.row(), deps)).status, 'completed')
  assert.equal((await resumeDraftCompletion(f.db, f.row(), deps)).status, 'completed'); assert.equal(tasks, 1)
})

test('missing Jobber holds after completed tag and recovery preserves its provider receipt', async () => {
  const f = fixture(); delete f.row().completion_intent.memory
  let tags = 0, quotes = 0
  const deps: any = { store: f.store, ghl: { addTags: async () => { tags++ }, getContact: async () => ({ id: 'c1', tags: ['quote requested'] }) }, jobber: null, switches: { tag: true, jobberQuote: true, marvinTask: false }, access: async () => ({ allowed: true }) }
  const held = await resumeDraftCompletion(f.db, f.row(), deps)
  assert.equal(held.status, 'held'); assert.equal(held.reason, 'Jobber client unavailable'); assert.equal(tags, 1)
  deps.jobber = { createQuote: async () => { quotes++; return { id: 'q1', url: 'quote-url' } } }
  assert.equal((await resumeDraftCompletion(f.db, f.row(), deps)).status, 'completed'); assert.equal(tags, 1); assert.equal(quotes, 1)
})

test('bounded cursor reaches pending work beyond ten uncertain parents without replaying uncertain effects', async () => {
  const { resumePendingDraftCompletions } = await import('../src/mastra/draft-completion.ts')
  const store = new TestStore(); let retains = 0
  const rows = Array.from({ length: 11 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, completion_intent: { status: index < 10 ? 'uncertain' : 'pending', memory: { ...outcome, eventId: `page-${index}` } } }))
  for (let index = 0; index < 10; index++) {
    const key = `memory:page-${index}`
    await store.enqueue({ source_key: key }); store.rows.get(key).status = 'uncertain'
  }
  const db: any = { none: async () => {},
    any: async (query: string, values: any[] = []) => rows.filter(row => !query.includes('id > $1::uuid') || !values[0] || row.id > values[0]).filter(row => row.completion_intent.status !== 'completed').slice(0, 10),
    oneOrNone: async (_query: string, values: any[]) => { const row = rows.find(row => row.id === values[0])!; row.completion_intent = values[1]; return row } }
  const deps: any = { store, ghl: null, jobber: null, knowledge: { complete: async () => { retains++; return { operationId: 'new-receipt' } } } }
  const first = await resumePendingDraftCompletions(db, deps)
  assert.equal(first.length, 10); assert.ok(first.every(row => row.completion?.status === 'uncertain')); assert.equal(retains, 0)
  const second = await resumePendingDraftCompletions(db, deps, first.at(-1)!.draftId)
  assert.equal(second.length, 1); assert.equal(second[0].draftId, rows[10].id); assert.equal(second[0].completion?.status, 'completed'); assert.equal(retains, 1)
  assert.equal(store.rows.get('memory:page-0').status, 'uncertain')
})
