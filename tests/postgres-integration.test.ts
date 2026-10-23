import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { ensureAppTables } from '../src/mastra/tables.ts'
import { conversationAccess, controlConversation, setConversationOwner, stopConversation } from '../src/mastra/conversation-control.ts'
import { ensureDurableWorkTables, PgDurableWorkStore, runDurableEffect, type WorkSql } from '../src/mastra/durable-work.ts'
import { prepareDueFollowupDrafts, registerSentQuote } from '../src/mastra/followup-runtime.ts'

import { ghlClient } from '../src/mastra/ghl.ts'
import { PostgresStore } from '@mastra/pg'
import { findDraft, saveDraft } from '../src/mastra/drafts.ts'
import { resumeDraftCompletion, type CompletionIntent } from '../src/mastra/draft-completion.ts'

// No .env/DATABASE_URL: every query targets an owned, ephemeral Unix-socket cluster.
const require = createRequire(import.meta.url)
function binary(name: string) {
  const brew = `/opt/homebrew/bin/${name}`
  if (existsSync(brew)) return brew
  try { return execFileSync('which', [name], { encoding: 'utf8' }).trim() } catch { return '' }
}
const initdb = binary('initdb'), pgctl = binary('pg_ctl')
let Pool: any
try { ({ Pool } = createRequire(require.resolve('@mastra/pg'))('pg')) } catch { /* explicit skip below */ }

test('REAL PostgreSQL ownership and durable-work acceptance', {
  skip: !initdb || !pgctl || !Pool ? 'requires local initdb, pg_ctl, and the installed @mastra/pg pg driver' : false,
  timeout: 60_000,
}, async t => {
  const root = mkdtempSync('/tmp/dynamite-pg-acceptance-')
  const data = join(root, 'data')
  const port = 20_000 + Math.floor(Math.random() * 30_000)
  const pools: any[] = []
  let started = false
  function connect(): WorkSql & { close(): Promise<void> } {
    const pool = new Pool({ host: root, port, user: 'dynamite_test', database: 'postgres', max: 8,
      connectionTimeoutMillis: 5_000, idleTimeoutMillis: 1_000 })
    pools.push(pool)
    return {
      async none(query, values) { const result = await pool.query(query, values); assert.equal(result.rows.length, 0, 'none query unexpectedly returned rows') },
      async oneOrNone<T>(query: string, values?: unknown[]): Promise<T | null> {
        const result = await pool.query(query, values)
        assert.ok(result.rows.length <= 1, 'oneOrNone returned multiple rows')
        return result.rows[0] ?? null
      },
      async any<T>(query: string, values?: unknown[]): Promise<T[]> { return (await pool.query(query, values)).rows },
      async close() { await pool.end(); pools.splice(pools.indexOf(pool), 1) },
    }
  }
  try {
    execFileSync(initdb, ['-D', data, '-A', 'trust', '-U', 'dynamite_test', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' })
    execFileSync(pgctl, ['-D', data, '-l', join(root, 'server.log'), '-o', `-F -k ${root} -p ${port} -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe' })
    started = true
    const db = connect()
    const identity = await db.oneOrNone<{ database: string; tcp: string | null }>('SELECT current_database() AS database, inet_server_addr()::text AS tcp')
    assert.deepEqual(identity, { database: 'postgres', tcp: null })
    await ensureAppTables(db)
    await ensureDurableWorkTables(db)

    await t.test('takeover survives closing its DB pool; explicit resume persists', async () => {
      const writer = connect()
      assert.equal((await controlConversation(true, writer, { contactId: 'takeover', owner: 'human', phone: '+15550000001' })).status, 200)
      await writer.close()
      assert.deepEqual(await conversationAccess(db, 'takeover', '(555) 000-0001'), { allowed: false, reason: 'human_owned' })
      await setConversationOwner(db, 'takeover', 'bot')
      assert.deepEqual(await conversationAccess(db, 'takeover', '+15550000001'), { allowed: true })
    })
    await t.test('contact-only and phone-only STOP persist and resume never clears STOP', async () => {
      await stopConversation(db, 'contact-stop', '')
      await setConversationOwner(db, 'contact-stop', 'bot', '+15550000002')
      assert.equal((await conversationAccess(db, 'contact-stop', '+15550000002')).reason, 'opt_out')
      await stopConversation(db, '', '(555) 000-0003')
      const reader = connect()
      assert.equal((await conversationAccess(reader, 'phone-stop', '+15550000003')).reason, 'opt_out')
      await setConversationOwner(reader, 'phone-stop', 'bot')
      assert.equal((await conversationAccess(reader, 'phone-stop', '+15550000004')).reason, 'opt_out')
      // Match historic noncanonical opt-out rows as well as new normalized writes.
      await db.none("INSERT INTO sms_opt_outs (phone, reason) VALUES ('(555) 000-0005', 'stop')")
      assert.equal((await conversationAccess(reader, 'historic-stop', '+15550000005')).reason, 'opt_out')
    })
    await t.test('alias collision holds both contacts without reassigning original alias', async () => {
      assert.equal((await conversationAccess(db, 'alias-a', '+15550000006')).allowed, true)
      const reader = connect()
      assert.equal((await conversationAccess(reader, 'alias-b', '+15550000006')).reason, 'identity_conflict')
      await setConversationOwner(db, 'alias-a', 'bot')
      assert.equal((await conversationAccess(db, 'alias-a', '+15550000006')).reason, 'identity_conflict')
      assert.deepEqual(await db.oneOrNone('SELECT contact_id FROM sms_phone_aliases WHERE phone=$1', ['+15550000006']), { contact_id: 'alias-a' })
      assert.equal((await conversationAccess(db, 'unresolved', '')).reason, 'identity_unresolved')
    })
    const item = { source_key: 'acceptance:handoff:one', kind: 'handoff', contact_id: 'takeover', due_at: new Date('2026-10-20T12:00:00Z'), payload: { stage: 'task', nested: { durable: true } } }
    await t.test('atomic concurrent workers dispatch once and new connection reuses JSON receipt', async () => {
      const peer = connect(), first = new PgDurableWorkStore(db), second = new PgDurableWorkStore(peer)
      let dispatches = 0
      const dispatch = async () => {
        dispatches++
        assert.equal((await new PgDurableWorkStore(peer).get(item.source_key))?.status, 'dispatching')
        return { providerId: 'offline-provider-1', result: { acknowledged: true } }
      }
      await Promise.all(Array.from({ length: 16 }, (_, i) => runDurableEffect(i % 2 ? first : second, item, dispatch)))
      await peer.close()
      const replay = await runDurableEffect(new PgDurableWorkStore(connect()), item, dispatch)
      assert.equal(dispatches, 1)
      assert.equal(replay.status, 'completed')
      assert.deepEqual(replay.receipt, { providerId: 'offline-provider-1', result: { acknowledged: true } })
      assert.deepEqual(replay.payload, item.payload)
    })
    await t.test('interrupted and unacknowledged dispatches remain held across stores', async () => {
      const first = new PgDurableWorkStore(db), restarted = new PgDurableWorkStore(connect())
      const interrupted = { ...item, source_key: 'acceptance:interrupted' }
      await first.enqueue(interrupted); await first.claim(interrupted.source_key)
      let dispatches = 0
      const dispatch = async () => { dispatches++; return { providerId: '' } }
      assert.equal((await runDurableEffect(restarted, interrupted, dispatch)).status, 'dispatching')
      await restarted.quarantineInterrupted(interrupted.source_key)
      assert.equal((await runDurableEffect(first, interrupted, dispatch)).status, 'uncertain')
      assert.equal(dispatches, 0)
      const noAck = { ...item, source_key: 'acceptance:no-ack' }
      assert.equal((await runDurableEffect(first, noAck, dispatch)).status, 'uncertain')
      assert.equal((await runDurableEffect(restarted, noAck, dispatch)).status, 'uncertain')
      assert.equal(dispatches, 1)
      assert.equal((await restarted.get(item.source_key))?.receipt?.providerId, 'offline-provider-1')
    })
    await t.test('due SQL filters kind/status/date, orders rows, and persists deferral', async () => {
      const store = new PgDurableWorkStore(db), now = new Date('2026-10-22T12:00:00Z')
      for (const [key, kind, date] of [['due-b', 'quote_followup', '2026-10-21'], ['due-a', 'quote_followup', '2026-10-21'], ['future', 'quote_followup', '2026-10-23'], ['wrong-kind', 'handoff', '2026-10-21']] as const)
        await store.enqueue({ ...item, source_key: key, kind, due_at: new Date(date) })
      assert.deepEqual((await store.due(now, 10)).map(row => row.source_key), ['due-a', 'due-b'])
      assert.deepEqual((await store.due(now, 1)).map(row => row.source_key), ['due-a'])
      await store.claim('due-a'); await store.defer('due-a', new Date('2026-10-24'))
      await store.claim('due-b'); await store.finish('due-b', 'cancelled', { reason: 'live_stop' })
      assert.deepEqual(await new PgDurableWorkStore(connect()).due(now, 10), [])
    })
    await t.test('quote registry idempotently schedules four durable rows with JSON quote identity', async () => {
      const quoteSentAt = new Date('2026-10-10T16:00:00Z')
      const quote = { contactId: 'registered-quote', quoteRef: 'offline-quote-1', quoteSentAt }
      await registerSentQuote(db, quote)
      const reader = connect()
      await registerSentQuote(reader, quote)
      const registry = await reader.oneOrNone<{ quote_ref: string; sent_at: Date }>('SELECT quote_ref,sent_at FROM sales_followup_quotes WHERE contact_id=$1', [quote.contactId])
      assert.equal(registry?.quote_ref, quote.quoteRef)
      assert.equal(registry?.sent_at.toISOString(), quoteSentAt.toISOString())
      const rows = await reader.any<{ payload: { quoteRef: string }; status: string }>('SELECT payload,status FROM durable_sales_work WHERE contact_id=$1 ORDER BY due_at', [quote.contactId])
      assert.equal(rows.length, 4)
      assert.ok(rows.every(row => row.payload.quoteRef === quote.quoteRef && row.status === 'pending'))
    })
    await t.test('actual followup adapter persists draft/photo receipts, restarts and reconstructs spacing/history', async () => {
      // The fake clock represents DB wall-clock time; only created_at is moved to
      // that instant after insertion so restart spacing uses persisted SQL history.
      await db.none("UPDATE durable_sales_work SET status='cancelled' WHERE status='pending'")
      const quoteSentAt = new Date('2026-10-11T16:00:00Z')
      const now = new Date('2026-10-12T21:00:00Z')
      const contactId = 'adapter-history', phone = '+15551110010'
      const methods: string[] = []
      const ghl = ghlClient('offline-fixture', 'https://offline.test', async (url, init) => {
        methods.push(init?.method ?? 'GET')
        assert.equal(init?.method, 'GET', 'followup runner must never send to a provider')
        const path = new URL(String(url)).pathname
        const body = path.startsWith('/contacts/') ? { contact: { id: contactId, phone } }
          : path.endsWith('/messages') ? { messages: { messages: [] } } : { conversations: [{ id: 'offline-thread' }] }
        return new Response(JSON.stringify(body))
      })!
      const jobber = { quoteStatusForPhone: async () => 'sent' as const } as any
      const priorBase = process.env.PHOTO_BASE_URL
      process.env.PHOTO_BASE_URL = 'https://offline.test/photos'
      const writer = connect()
      try {
        await registerSentQuote(writer, { contactId, quoteRef: 'q-history', quoteSentAt })
        const first = await prepareDueFollowupDrafts(writer, { ghl, jobber }, now)
        assert.equal(first.length, 1)
        assert.equal(first[0].status, 'completed')
        const draft = await writer.oneOrNone<any>('SELECT id,ghl_message_id,reply,media_urls,photo_ids FROM sms_drafts WHERE contact_id=$1', [contactId])
        assert.equal(draft.ghl_message_id, 'followup:adapter-history:q-history:1')
        assert.equal(draft.reply, 'we just finished this one! want me to add you to the route?')
        assert.deepEqual(draft.media_urls, ['https://offline.test/photos/dyn-rooftop-install-01.jpg'])
        assert.deepEqual(draft.photo_ids, ['rooftop-01'])
        assert.equal(String(first[0].receipt?.draftId), String(draft.id))
        await writer.none('UPDATE sms_drafts SET created_at=$2 WHERE id=$1', [draft.id, now])
        await writer.close()
        const restarted = connect()
        assert.deepEqual(await prepareDueFollowupDrafts(restarted, { ghl, jobber }, now), [])
        assert.equal((await restarted.any('SELECT id FROM sms_drafts WHERE contact_id=$1', [contactId])).length, 1)
        // Sequence two is due at 48h, but 19h since the previous draft still holds.
        const tooSoon = await prepareDueFollowupDrafts(restarted, { ghl, jobber }, new Date('2026-10-13T16:00:00Z'))
        assert.equal(tooSoon[0].status, 'pending')
        assert.equal((await restarted.any('SELECT id FROM sms_drafts WHERE contact_id=$1', [contactId])).length, 1)
        const second = await prepareDueFollowupDrafts(restarted, { ghl, jobber }, new Date('2026-10-13T17:00:00Z'))
        assert.equal(second[0].source_key, 'followup:adapter-history:q-history:2')
        assert.equal(second[0].status, 'completed')
        const drafts = await restarted.any<any>('SELECT ghl_message_id,reply,media_urls,photo_ids FROM sms_drafts WHERE contact_id=$1 ORDER BY ghl_message_id', [contactId])
        assert.equal(drafts.length, 2)
        assert.equal(drafts[1].reply, 'this one went up this week and the neighbors are already jealous lol. want me to pencil you in?')
        assert.deepEqual(drafts[1].photo_ids, ['warmwhite-colonial-02'])
        assert.deepEqual(drafts[1].media_urls, ['https://offline.test/photos/dyn-warmwhite-brick-colonial-02.jpg'])
        assert.ok(methods.length > 0 && methods.every(method => method === 'GET'))
      } finally {
        if (priorBase === undefined) delete process.env.PHOTO_BASE_URL
        else process.env.PHOTO_BASE_URL = priorBase
      }
    })
    await t.test('actual adapter cancels STOP and attachment-only reply; unknown quote defers without drafts or sends', async () => {
      await db.none("UPDATE durable_sales_work SET status='cancelled' WHERE status='pending'")
      const now = new Date('2026-10-12T16:00:00Z')
      for (const [index, scenario] of ['stop', 'reply', 'unknown'].entries()) {
        const contactId = `adapter-${scenario}`, phone = `+1555111002${index}`
        await registerSentQuote(db, { contactId, quoteRef: `q-${scenario}`, quoteSentAt: new Date('2026-10-11T16:00:00Z') })
        if (scenario === 'stop') await stopConversation(db, contactId, phone)
        let writes = 0
        const ghl = ghlClient('offline-fixture', 'https://offline.test', async (url, init) => {
          if (init?.method !== 'GET') writes++
          const path = new URL(String(url)).pathname
          const body = path.startsWith('/contacts/') ? { contact: { id: contactId, phone } }
            : path.endsWith('/messages') ? { messages: { messages: scenario === 'reply' ? [{ id: 'attachment-reply', direction: 'inbound', messageType: 'SMS', body: '', dateAdded: '2026-10-11T17:00:00Z', attachments: ['https://offline.test/customer.jpg'] }] : [] } }
              : { conversations: [{ id: 'offline-thread' }] }
          return new Response(JSON.stringify(body))
        })!
        const jobber = { quoteStatusForPhone: async () => scenario === 'unknown' ? 'unknown' : 'sent' } as any
        const result = await prepareDueFollowupDrafts(db, { ghl, jobber }, now)
        const row = result.find(row => row.contact_id === contactId)!
        assert.equal(row.status, scenario === 'unknown' ? 'pending' : 'cancelled')
        if (scenario === 'unknown') assert.equal(row.due_at.toISOString(), '2026-10-12T17:00:00.000Z')
        assert.deepEqual(await db.any('SELECT id FROM sms_drafts WHERE contact_id=$1', [contactId]), [])
        assert.equal(writes, 0)
      }
    })
    await t.test('draft completion JSON survives reopen and a lost parent update reuses durable child receipts', async () => {
      const contactId = 'completion-restart', messageId = 'completion-restart-event'
      const intent: CompletionIntent = {
        status: 'pending',
        handoff: { contactId, name: 'Offline Fixture', phone: '+15551110030', address: 'Fixture address' },
        memory: { eventId: messageId, outcome: 'quote_requested', dealState: 'CONFIRMED', photoUsed: false },
      }
      const writer = connect()
      const saved = await saveDraft(writer, { messageId, contactId, phone: intent.handoff!.phone,
        inbound: 'offline fixture', reply: 'offline draft', needsHuman: false, blocked: [],
        dealState: 'CONFIRMED', salesDraft: true, completionIntent: intent })
      await writer.close()
      const reader = connect()
      const recovered = await findDraft(reader, messageId)
      assert.ok(recovered)
      assert.equal(String(recovered.id), String(saved.draft.id))
      assert.deepEqual(recovered.completion_intent, intent)
      let tags = 0, retains = 0
      const deps = {
        ghl: { addTags: async () => { tags++ }, getContact: async () => ({ id: contactId, tags: ['quote requested'] }) } as any,
        jobber: null, switches: { tag: true, jobberQuote: false, marvinTask: false },
        access: async () => ({ allowed: true }),
        knowledge: { complete: async (outcome: unknown) => { assert.deepEqual(outcome, intent.memory); retains++; return { operationId: 'offline-retain-receipt' } } } as any,
      }
      // Provider receipts commit successfully, then the parent UPDATE fails. The
      // original pending JSON must remain discoverable and resume without repeats.
      const failParentUpdate: WorkSql = {
        none: reader.none, any: reader.any,
        async oneOrNone<T>(query: string, values?: unknown[]): Promise<T | null> {
          if (query.startsWith('UPDATE sms_drafts SET completion_intent')) throw new Error('injected lost parent update')
          return reader.oneOrNone<T>(query, values)
        },
      }
      await assert.rejects(resumeDraftCompletion(failParentUpdate, recovered, deps), /injected lost parent update/)
      const pending = await reader.any<any>("SELECT id,completion_intent FROM sms_drafts WHERE completion_intent->>'status'='pending' AND ghl_message_id=$1", [messageId])
      assert.equal(pending.length, 1)
      assert.deepEqual(pending[0].completion_intent, intent)
      const children = await reader.any<any>("SELECT source_key,status,receipt FROM durable_sales_work WHERE contact_id=$1 ORDER BY source_key", [contactId])
      assert.equal(children.length, 2)
      assert.ok(children.every(row => row.status === 'completed'))
      assert.deepEqual(children.map(row => row.receipt.providerId).sort(), [`${contactId}:quote requested`, 'offline-retain-receipt'].sort())
      await reader.close()
      const restarted = connect()
      const replayDraft = await findDraft(restarted, messageId)
      assert.ok(replayDraft)
      const completion = await resumeDraftCompletion(restarted, replayDraft, deps)
      assert.equal(completion?.status, 'completed')
      assert.equal(tags, 1); assert.equal(retains, 1)
      const finalDraft = await findDraft(connect(), messageId)
      assert.ok(finalDraft)
      assert.equal(String(finalDraft.id), String(saved.draft.id))
      assert.deepEqual(finalDraft.completion_intent, completion)
      assert.deepEqual(await resumeDraftCompletion(restarted, finalDraft, deps), completion)
      assert.equal(tags, 1); assert.equal(retains, 1)
      assert.equal((await restarted.any('SELECT id FROM sms_drafts WHERE ghl_message_id=$1', [messageId])).length, 1)
      assert.equal((await restarted.any('SELECT source_key FROM durable_sales_work WHERE contact_id=$1', [contactId])).length, 2)
    })
    await t.test('installed Mastra PostgresStore.db satisfies the real narrow WorkSql boundary', async () => {
      const storage = new PostgresStore({ id: 'offline-worksql', host: root, port, user: 'dynamite_test', password: 'offline-trust-auth-fixture', database: 'postgres', disableInit: true })
      try {
        const actual: WorkSql = storage.db
        await ensureDurableWorkTables(actual)
        const store = new PgDurableWorkStore(actual)
        const input = { ...item, source_key: 'acceptance:mastra-db', payload: { proof: 'actual-postgresstore' } }
        await store.enqueue(input)
        assert.equal((await store.claim(input.source_key))?.status, 'dispatching')
        await store.finish(input.source_key, 'completed', { providerId: 'offline-mastra-db' })
        assert.deepEqual((await new PgDurableWorkStore(connect()).get(input.source_key))?.receipt, { providerId: 'offline-mastra-db' })
      } finally { await storage.close() }
    })
  } finally {
    await Promise.all(pools.map(pool => pool.end()))
    // Remove only the unique cluster this test created, and only after confirmed shutdown.
    if (started) execFileSync(pgctl, ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' })
    rmSync(root, { recursive: true, force: true })
  }
})
