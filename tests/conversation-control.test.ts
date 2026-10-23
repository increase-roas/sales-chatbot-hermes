import test from 'node:test'
import { ghlSmsRoute } from '../src/mastra/routes/ghl-sms.ts'
import { sendApprovedDraft } from '../src/mastra/drafts.ts'
import assert from 'node:assert/strict'
import { conversationAccess, setConversationOwner, stopConversation, validateDraftIdentity, controlConversation } from '../src/mastra/conversation-control.ts'

// Stateful fake of the narrow SQL contract. Proves handler-independent persistence/control flow,
// not Postgres locking, migrations, or a hosted database.
function database() {
  const contacts = new Map<string, any>(), aliases = new Map<string, string>(), stops = new Set<string>()
  return {
    async none(q: string, v: any[] = []) {
      if (q.includes('/* control:ensure */')) { if (!contacts.has(v[0])) contacts.set(v[0], { owner: 'bot', stopped: false, identity_hold: false }) }
      if (q.includes('/* control:hold */')) for (const id of v[0]) { const c = contacts.get(id); if (c) c.identity_hold = true }
      if (q.includes('/* control:stop */')) contacts.get(v[0]).stopped = true
      if (q.includes('/* control:phone-stop */')) stops.add(v[0])
      if (q.includes('/* control:owner */')) contacts.get(v[0]).owner = v[1]
    },
    async any() { return [] },
    async oneOrNone(q: string, v: any[] = []) {
      if (q.includes('JOIN sms_drafts')) return { contact_id: 'c', phone: '+15551234567', reply: 'approved', media_urls: [] }
      if (q.includes('/* control:alias */')) { if (!aliases.has(v[0])) aliases.set(v[0], v[1]); return { contact_id: aliases.get(v[0]) } }
      if (q.includes('/* control:state */')) return contacts.get(v[0]) ?? null
      if (q.includes('/* control:optout */')) return stops.has(v[0]) ? { phone: v[0] } : null
      throw new Error(`Unexpected query ${q}`)
    },
  } as any
}

test('normal drafts require both stable IDs; STOP is separate', () => {
  assert.equal(validateDraftIdentity('', 'm'), false)
  assert.equal(validateDraftIdentity('c', ''), false)
  assert.equal(validateDraftIdentity('c', 'm'), true)
})
test('human ownership survives independent access and only explicit resume changes it', async () => {
  const db = database()
  await setConversationOwner(db, 'c', 'human', '+1 555 123 4567')
  assert.equal((await conversationAccess(db, 'c', '+15551234567')).reason, 'human_owned')
  assert.equal((await conversationAccess(db, 'c', '+15551234567')).allowed, false)
  await setConversationOwner(db, 'c', 'bot')
  assert.equal((await conversationAccess(db, 'c', '+15551234567')).allowed, true)
})
test('contact-only STOP propagates to later phone and resume cannot undo it', async () => {
  const db = database()
  await stopConversation(db, 'c', '')
  await setConversationOwner(db, 'c', 'bot', '+15551234567')
  assert.equal((await conversationAccess(db, 'c', '+15551234567')).reason, 'opt_out')
})
test('phone-only STOP propagates once authoritative contact phone resolves', async () => {
  const db = database()
  await stopConversation(db, '', '(555) 123-4567')
  assert.equal((await conversationAccess(db, 'c', '+15551234567')).reason, 'opt_out')
  assert.equal((await conversationAccess(db, 'c', '+15559876543')).reason, 'opt_out')
})
test('phone alias collision holds both contacts; operator resume cannot clear conflict', async () => {
  const db = database()
  assert.equal((await conversationAccess(db, 'a', '+15551234567')).allowed, true)
  assert.equal((await conversationAccess(db, 'b', '+15551234567')).reason, 'identity_conflict')
  await setConversationOwner(db, 'a', 'bot')
  assert.equal((await conversationAccess(db, 'a', '+15551234567')).allowed, false)
})
test('unresolved identity never permits sending', async () => {
  const db = database()
  assert.equal((await conversationAccess(db, 'c', '')).reason, 'identity_unresolved')
  assert.equal((await conversationAccess(db, '', '+15551234567')).allowed, false)
})
test('control requires auth, validates body and persists before acknowledgement', async () => {
  const db = database()
  assert.equal((await controlConversation(false, db, { contactId: 'c', owner: 'human' })).status, 401)
  assert.equal((await controlConversation(true, db, { contactId: 'c', owner: 'resume' })).status, 400)
  assert.equal((await controlConversation(true, null, { contactId: 'c', owner: 'bot' })).status, 503)
  assert.equal((await controlConversation(true, db, { contactId: 'c', owner: 'human' })).status, 200)
  assert.equal((await conversationAccess(db, 'c', '+15551234567')).reason, 'human_owned')
})

const contact = { id: 'c', phone: '+15551234567', tags: [], name: '', email: '', address: '' }
test('approved delivery rechecks fresh contact phone and persisted human ownership', async () => {
  const db = database()
  await setConversationOwner(db, 'c', 'human', contact.phone)
  let sends = 0
  const opts = { jobber: { quoteStatusForPhone: async () => 'none' }, enabled: true, apiKey: 'offline', fetchImpl: async () => { sends++; throw new Error('unexpected send') }, ghl: { getContact: async () => contact } }
  assert.equal((await sendApprovedDraft(db, 'draft', opts as any)).reason, 'human_owned')
  assert.equal((await sendApprovedDraft(db, 'draft', { ...opts, ghl: { getContact: async () => ({ ...contact, phone: '+15559876543' }) } } as any)).reason, 'identity_unresolved')
  assert.equal(sends, 0)
})
test('approved delivery observes STOP added while quote lookup is in flight', async () => {
  const db = database()
  let sends = 0
  const result = await sendApprovedDraft(db, 'draft', {
    enabled: true, apiKey: 'offline',
    fetchImpl: async () => { sends++; throw new Error('unexpected send') },
    ghl: { getContact: async () => contact },
    jobber: { quoteStatusForPhone: async () => { await stopConversation(db, 'c', contact.phone); return 'none' } } as any,
  })
  assert.equal(result.reason, 'opt_out')
  assert.equal(sends, 0)
})

test('webhook rejects missing normal IDs before any generation, but persists STOP first', async () => {
  process.env.GHL_WEBHOOK_SECRET = 'offline-webhook'
  const db = database()
  let generated = 0, flushed = 0
  const mastra = { getStorage: () => ({ db }), getAgentById: () => ({ generate: async () => { generated++; throw new Error('unexpected generation') } }), observability: { flush: async () => { flushed++ } } }
  const invoke = async (payload: any) => (ghlSmsRoute.handler as any)({
    req: { header: () => 'offline-webhook', json: async () => payload }, get: () => mastra,
    json: (body: any, status = 200) => ({ body, status }),
  })
  try {
    assert.equal((await invoke({ contactId: 'c', phone: contact.phone, message: 'hello' })).status, 400)
    assert.equal((await invoke({ phone: contact.phone, messageId: 'm', message: 'hello' })).status, 400)
    assert.equal((await invoke({ contactId: 'c', message: 'STOP' })).body.blocked[0], 'opt_out')
    assert.equal((await conversationAccess(db, 'c', contact.phone)).reason, 'opt_out')
    assert.equal((await invoke({ phone: '+15559876543', message: 'STOP' })).status, 200)
    assert.equal((await conversationAccess(db, 'another', '+15559876543')).reason, 'opt_out')
    assert.equal(generated, 0)
    assert.equal(flushed, 4)
  } finally { delete process.env.GHL_WEBHOOK_SECRET }
})
