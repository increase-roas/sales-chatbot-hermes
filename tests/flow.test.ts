import { TestStore } from './durable-work.test.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FOLLOWUP_LINES, nextFollowup } from '../src/mastra/followups.ts'

test('saved followup plan controls cadence, wording, photos and pause', () => {
  const state = { quoteSentAt: new Date('2026-10-20T12:00:00Z'), approved: false, linesSent: [], photosSent: [] }
  const settings = { enabled: false, spacingHours: [12], minimumGapHours: 2, lines: ['a saved followup?'], quietStart: 22, quietEnd: 8, timeZone: 'UTC', personalAfterHours: 3, callCooldownMinutes: 20 }
  const now = new Date('2026-10-21T10:00:00Z')
  assert.equal(nextFollowup(state, now, { settings }), null)
  const due = nextFollowup(state, now, { settings: { ...settings, enabled: true }, photos: { installEnabled: false, rapportEnabled: false, disabledIds: [], overrides: [] } })!
  assert.equal(due.line, 'a saved followup?')
  assert.equal(due.due.toISOString(), '2026-10-21T00:00:00.000Z')
  assert.equal(due.photo, null)
})
import { stripDashes } from '../src/mastra/guard.ts'
import type { GhlClient } from '../src/mastra/ghl.ts'
import { MARVIN_USER_ID } from '../src/mastra/ghl.ts'
import type { JobberClient } from '../src/mastra/jobber.ts'
import { flowSwitches, marvinTaskText, runQuoteRequestedFlow } from '../src/mastra/quote-flow.ts'

function fakes() {
  const calls: string[] = []
  const ghl: GhlClient = {
    getContact: async id => ({ id, tags: ['quote requested'], name: 'Test Lead', phone: '+15550100', email: '', address: '10 Oak Ave' }),
    addTags: async (id, tags) => { calls.push(`tag ${id} ${tags.join(',')}`) },
    createTask: async (id, t) => { calls.push(`task ${id} ${t.assignedTo} ${t.title}`); return { id: 'task-1' } },
    searchOpportunities: async () => [],
  }
  const jobber: JobberClient = {
    quoteStatusForPhone: async () => 'none',
    createQuote: async q => { calls.push(`quote ${q.address}`); return { id: 'q-1', url: 'https://secure.getjobber.com/quotes/q-1' } },
  }
  return { ghl, jobber, calls }
}

const req = { contactId: 'c-test', name: 'Test Lead', phone: '+15550100', address: '10 Oak Ave, Troy, MI', mockupUrl: 'https://example.com/mockup.jpg' }

test('flow is fully off by default (no live writes)', async () => {
  const { ghl, jobber, calls } = fakes()
  assert.deepEqual(flowSwitches({}), { tag: false, jobberQuote: false, marvinTask: false })
  const steps = await runQuoteRequestedFlow(req, { ghl, jobber, access: async () => ({ allowed: true }), journal: { store: new TestStore(), conversationId: 'test' }, switches: flowSwitches({}) })
  assert.deepEqual(calls, [])
  assert.ok(steps.every(s => !s.done))
})

test('yes + address: tag, Jobber quote, then a task for Marvin with both links', async () => {
  const { ghl, jobber, calls } = fakes()
  const steps = await runQuoteRequestedFlow(req, { ghl, jobber, access: async () => ({ allowed: true }), journal: { store: new TestStore(), conversationId: 'test' }, switches: { tag: true, jobberQuote: true, marvinTask: true }, now: new Date('2026-10-15T18:00:00Z') })
  assert.deepEqual(calls, ['tag c-test quote requested', 'quote 10 Oak Ave, Troy, MI', `task c-test ${MARVIN_USER_ID} Call Test Lead: holiday lights quote requested`])
  assert.ok(steps.every(s => s.done))
  const { body } = marvinTaskText(req, 'https://secure.getjobber.com/quotes/q-1')
  assert.match(body, /send the quote by email AND text/)
  assert.match(body, /https:\/\/secure\.getjobber\.com\/quotes\/q-1/)
  assert.match(body, /https:\/\/example\.com\/mockup\.jpg/)
})

test('follow-ups: 24h/48h/4d/7d, never repeat a line or photo, stop on approval or reply, max 4', () => {
  const sentAt = new Date('2026-10-15T00:00:00Z')
  const day = (d: number) => new Date(sentAt.getTime() + d * 86_400_000)
  const state = { quoteSentAt: sentAt, approved: false, linesSent: [] as string[], photosSent: [] as string[] }
  assert.equal(nextFollowup(state, day(0.5)), null)
  const used = new Set<string>()
  const usedPhotos = new Set<string>()
  for (const d of [1, 2, 4, 7]) {
    const f = nextFollowup(state, day(d), { includePendingPhotos: true })!
    assert.ok(f, `due on day ${d}`)
    assert.ok(!used.has(f.line))
    assert.ok(f.photo && !usedPhotos.has(f.photo.id))
    assert.equal(stripDashes(f.line), f.line)
    used.add(f.line); usedPhotos.add(f.photo!.id)
    state.linesSent.push(f.line); state.photosSent.push(f.photo!.id)
  }
  assert.equal(nextFollowup(state, day(30)), null)
  assert.equal(nextFollowup({ ...state, linesSent: [], approved: true }, day(5)), null)
  assert.equal(nextFollowup({ ...state, linesSent: [], customerRepliedSince: true }, day(5)), null)
  assert.ok(FOLLOWUP_LINES.length >= 8)
  // Quiet hours: 2am Detroit (06:00Z in October) is never a follow-up time.
  assert.equal(nextFollowup({ ...state, linesSent: [] }, new Date('2026-10-17T06:00:00Z')), null)
})

test('follow-ups attach a consented photo', () => {
  const f = nextFollowup({ quoteSentAt: new Date(0), approved: false, linesSent: [], photosSent: [] }, new Date(5 * 86_400_000))
  assert.ok(f?.photo && f.photo.consent === 'granted')
})
