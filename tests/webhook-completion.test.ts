import { defaultSettings } from '../src/mastra/control-settings.ts'
import { SALES_INSTRUCTIONS } from '../src/mastra/agents/sales-agent.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ghlSmsRoute } from '../src/mastra/routes/ghl-sms.ts'
import { DYNAMITE_COMPANY_ID } from '../src/mastra/customer-context.ts'
import { setConversationOwner, stopConversation } from '../src/mastra/conversation-control.ts'

function database() {
  const controls = new Map<string, any>(), aliases = new Map<string, string>(), drafts = new Map<string, any>(), work = new Map<string, any>()
  return { drafts, aliases,
    async none(q: string, v: any[] = []) {
      if (q.includes('control:ensure') && !controls.has(v[0])) controls.set(v[0], { owner: 'bot', stopped: false, identity_hold: false })
      if (q.includes('control:owner')) controls.get(v[0]).owner = v[1]
      if (q.includes('control:stop')) controls.get(v[0]).stopped = true
    },
    async any() { return [] },
    async oneOrNone(q: string, v: any[] = []) {
      // This fixture starts with a published configuration matching its enabled memory connection.
      if (q.includes('JOIN manny_settings_active')) return { id: 'fixture-settings', label: 'Fixture settings', settings: defaultSettings(SALES_INSTRUCTIONS), hash: 'fixture', created_at: new Date(0) }
      if (q.includes('control:state')) return controls.get(v[0])
      if (q.includes('control:alias')) { if (!aliases.has(v[0])) aliases.set(v[0], v[1]); return { contact_id: aliases.get(v[0]) } }
      if (q.includes('control:optout')) return null
      if (q.includes('INSERT INTO sms_drafts')) { const row = { id: 'd1', reply: v[4], needs_human: v[5], blocked: v[6], deal_state: v[7], sales_draft: v[8], media_urls: v[9], completion_intent: v[11] }; if (drafts.has(v[0])) return null; drafts.set(v[0], row); return row }
      if (q.includes('FROM sms_drafts WHERE ghl_message_id')) return drafts.get(v[0]) ?? null
      if (q.includes('UPDATE sms_drafts SET completion_intent')) { const row = [...drafts.values()].find(r => r.id === v[0]); row.completion_intent = v[1]; return row }
      if (q.includes('INSERT INTO durable_sales_work')) { if (work.has(v[0])) return null; const row = { source_key: v[0], status: 'pending', receipt: null }; work.set(v[0], row); return row }
      if (q.includes('SELECT * FROM durable_sales_work')) return work.get(v[0]) ?? null
      if (q.includes("SET status = 'dispatching'")) { const row = work.get(v[0]); if (row.status !== 'pending') return null; row.status = 'dispatching'; return row }
      if (q.includes('UPDATE durable_sales_work SET status = $2')) { const row = work.get(v[0]); row.status = v[1]; row.receipt = v[2]; return row }
      throw Error(`Unexpected fake query: ${q}`)
    },
  }
}
const phone = '+13135550123'
async function fixture(run: (f: any) => Promise<void>, failing = '') {
  const priorEnv = { ...process.env }, fetcher = globalThis.fetch, db = database(); let generated = 0, retains = 0, posts = 0, instructions = ''
  Object.assign(process.env, { GHL_WEBHOOK_SECRET: 'offline', GHL_API_KEY: 'offline', HINDSIGHT_ENABLED: 'true', HINDSIGHT_API_KEY: 'offline', HINDSIGHT_BANK_ID: `paperclip::${DYNAMITE_COMPANY_ID}`, PAPERCLIP_COMPANY_ID: DYNAMITE_COMPANY_ID, HINDSIGHT_PAGE_IDS: 'rules', FLOW_TAG: 'true', FLOW_MARVIN_TASK: 'true' })
  delete process.env.GHL_SEND_ENABLED
  delete process.env.GHL_TEST_SEND_ENABLED
  delete process.env.FIREWORKS_API_KEY
  delete process.env.JOBBER_ACCESS_TOKEN
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST' && url.includes('leadconnector')) { posts++; return Response.json({ task: { id: 't1' } }) }
    if (url.includes('/contacts/')) return Response.json({ contact: { id: 'c1', phone, address1: '10 Oak Ave', tags: ['quote requested'] } })
    if (url.includes('/conversations/search')) return Response.json({ conversations: [] })
    if (url.endsWith('/banks')) return Response.json({ banks: [{ bank_id: process.env.HINDSIGHT_BANK_ID }] })
    if (failing && url.includes(failing)) return new Response('', { status: 503 })
    if (url.endsWith('/tree')) return Response.json({ roots: [{ id: 'rules', name: 'Rules', kind: 'page' }] })
    if (url.includes('/pages/')) return Response.json({ id: 'rules', name: 'Rules', markdown: 'OFFLINE_REFERENCE' })
    if (url.endsWith('/recall')) return Response.json({ results: [] })
    if (url.endsWith('/memories')) { retains++; return Response.json({ success: true, bank_id: process.env.HINDSIGHT_BANK_ID, operation_id: 'r1' }) }
    throw Error('Unexpected offline fetch')
  }
  let generationAction = async () => {}
  const mastra = { getStorage: () => ({ db }), getAgentById: () => ({ getMemory: async () => null, generate: async (_prompt: any, options: any) => { generated++; instructions = options.instructions; await generationAction(); return { text: 'I can help with your lights.' } } }), observability: { flush: async () => {} } }
  const invoke = (messageId = 'm1', payloadPhone = phone) => (ghlSmsRoute.handler as any)({ req: { header: () => 'offline', json: async () => ({ contactId: 'c1', messageId, phone: payloadPhone, message: 'yes, 10 Oak Ave' }) }, get: () => mastra, json: (body: any, status = 200) => ({ body, status }) })
  try { await run({ db, invoke, action: (fn: any) => { generationAction = fn }, counts: () => ({ generated, retains, posts, instructions }) }) }
  finally { globalThis.fetch = fetcher; for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key]; Object.assign(process.env, priorEnv) }
}
for (const failing of ['/tree', '/pages/', '/recall']) test(`enabled knowledge ${failing} failure persists empty human-held draft without generation or retention`, async () => {
  await fixture(async ({ invoke, db, counts }) => {
    const result = await invoke(); assert.equal(result.status, 200); assert.equal(result.body.reply, ''); assert.equal(result.body.needsHuman, true); assert.equal(result.body.salesDraft, false); assert.ok(result.body.blocked.includes('company_context_unavailable')); assert.equal(db.drafts.size, 1); assert.equal(counts().generated, 0); assert.equal(counts().retains, 0)
  }, failing)
})
test('success adds one reference instruction and retains one typed outcome across replay', async () => {
  await fixture(async ({ invoke, counts }) => { assert.equal((await invoke()).status, 200); const replay = await invoke(); assert.equal(replay.body.duplicate, true); assert.equal(replay.body.completion.status, 'completed'); assert.equal(counts().generated, 1); assert.equal(counts().retains, 1); assert.equal(counts().instructions.split('<company_memory>').length - 1, 1) })
})
for (const stop of [true, false]) test(`${stop ? 'STOP' : 'takeover'} during generation prevents all handoff effects`, async () => {
  await fixture(async ({ invoke, action, db, counts }) => { action(() => stop ? stopConversation(db, 'c1', '') : setConversationOwner(db, 'c1', 'human')); const result = await invoke(); assert.equal(result.status, 200); assert.equal(result.body.salesDraft, false); assert.equal(result.body.reply, ''); assert.equal(counts().posts, 0); assert.equal(counts().retains, 0) })
})
test('untrusted payload phone is never bound before authoritative contact comparison', async () => {
  await fixture(async ({ invoke, db, counts }) => { assert.equal((await invoke('m1', '+13135550999')).body.blocked[0], 'identity_conflict'); assert.equal(db.aliases.size, 0); assert.equal(counts().generated, 0) })
})

test('failure after atomic draft insert leaves recoverable intent and duplicate replay resumes without generation', async () => {
  await fixture(async ({ invoke, db, counts }) => {
    const query = db.oneOrNone.bind(db); let fail = true
    db.oneOrNone = async (q: string, values: any[]) => { if (q.includes('INSERT INTO durable_sales_work') && fail) { fail = false; throw Error('storage interrupted after saved draft') }; return query(q, values) }
    assert.equal((await invoke()).status, 503)
    const saved: any = [...db.drafts.values()][0]
    assert.equal(saved.completion_intent.status, 'pending'); assert.ok(saved.completion_intent.handoff); assert.ok(saved.completion_intent.memory)
    const replay = await invoke()
    assert.equal(replay.status, 200); assert.equal(replay.body.duplicate, true); assert.equal(replay.body.completion.status, 'completed')
    assert.equal(counts().generated, 1); assert.equal(counts().retains, 1)
  })
})
