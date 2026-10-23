import type { Settings, Version } from './control-settings.ts'
import { conversationAccess, normalizedPhone } from './conversation-control.ts'
import { photosSentTo, saveDraft } from './drafts.ts'
import { ensureDurableWorkTables, PgDurableWorkStore, type WorkSql } from './durable-work.ts'
import { scheduleQuoteFollowups, runDueQuoteFollowups } from './followup-runner.ts'
import type { GhlClient } from './ghl.ts'
import type { JobberClient } from './jobber.ts'
import { photoUrl } from './photos.ts'

export function hasReplyAfterQuote(messages: Array<{ role: 'user' | 'assistant'; text: string; at: string }>, sentAt: Date) {
  if (!Number.isFinite(sentAt.getTime())) throw new Error('quote timestamp unavailable')
  return messages.some(message => {
    const at = new Date(message.at).getTime()
    if (!Number.isFinite(at)) throw new Error('message timestamp unavailable')
    return message.role === 'user' && at > sentAt.getTime()
  })
}
const ready = new WeakMap<WorkSql, Promise<void>>()
export function ensureQuoteRegistry(db: WorkSql): Promise<void> {
  let pending = ready.get(db)
  if (!pending) {
    pending = createQuoteRegistry(db).catch(error => { ready.delete(db); throw error })
    ready.set(db, pending)
  }
  return pending
}
async function createQuoteRegistry(db: WorkSql) {
  await ensureDurableWorkTables(db)
  await db.none(`CREATE TABLE IF NOT EXISTS sales_followup_quotes (
    contact_id text PRIMARY KEY, quote_ref text NOT NULL, sent_at timestamptz NOT NULL,
    source text NOT NULL DEFAULT 'operator_verified_jobber', updated_at timestamptz NOT NULL DEFAULT now()
  )`)
}
// Explicit authenticated operator registration until native Jobber ID/sentAt fields are proven.
// It schedules draft preparation only, never customer delivery.
export async function registerSentQuote(db: WorkSql, input: { contactId: string; quoteRef: string; quoteSentAt: Date }, version?: Version) {
  if (!input.contactId.trim() || !input.quoteRef.trim() || !Number.isFinite(input.quoteSentAt.getTime()) || input.quoteSentAt > new Date()) throw new Error('verified sent quote identity and timestamp required')
  await ensureQuoteRegistry(db)
  await db.none(`INSERT INTO sales_followup_quotes (contact_id, quote_ref, sent_at) VALUES ($1,$2,$3)
    ON CONFLICT (contact_id) DO UPDATE SET quote_ref=EXCLUDED.quote_ref, sent_at=EXCLUDED.sent_at, updated_at=now()`, [input.contactId, input.quoteRef, input.quoteSentAt])
  return scheduleQuoteFollowups(new PgDurableWorkStore(db), { ...input, ...(version ? { settings: version.settings.followups, settingsVersionId: version.id } : {}) })
}
export async function prepareDueFollowupDrafts(db: WorkSql, deps: { ghl: GhlClient; jobber: JobberClient }, now = new Date(), settings?: Settings) {
  await ensureQuoteRegistry(db)
  return runDueQuoteFollowups(new PgDurableWorkStore(db), {
    async readCurrent(contactId) {
      const quote = await db.oneOrNone<{ quote_ref: string; sent_at: Date | string }>(`SELECT quote_ref, sent_at FROM sales_followup_quotes WHERE contact_id=$1`, [contactId])
      if (!quote) throw new Error('verified quote record unavailable')
      const contact = await deps.ghl.getContact(contactId)
      if (contact.id !== contactId || !normalizedPhone(contact.phone)) throw new Error('contact identity unavailable')
      const access = await conversationAccess(db, contactId, contact.phone)
      const quoteStatus = await deps.jobber.quoteStatusForPhone(contact.phone)
      if (quoteStatus === 'unknown') throw new Error('quote status unavailable')
      const messages = await deps.ghl.getThread(contactId)
      const rows = await db.any<{ reply: string; created_at: Date | string }>(`SELECT d.reply,d.created_at FROM durable_sales_work w
        JOIN sms_drafts d ON d.id::text=w.receipt->>'draftId'
        WHERE w.contact_id=$1 AND w.kind='quote_followup' AND w.status='completed' AND w.payload->>'quoteRef'=$2
        ORDER BY d.created_at`, [contactId, quote.quote_ref])
      const sentAt = new Date(quote.sent_at)
      return {
        optedOut: access.reason === 'opt_out', owner: access.reason === 'human_owned' ? 'human' as const : 'bot' as const,
        identityResolved: access.allowed, quoteRef: quote.quote_ref,
        state: { quoteSentAt: sentAt, approved: quoteStatus !== 'sent', linesSent: rows.map(r => r.reply), photosSent: await photosSentTo(db, contact.phone),
          lastFollowupAt: rows.length ? new Date(rows.at(-1)!.created_at) : undefined, customerRepliedSince: hasReplyAfterQuote(messages, sentAt) },
      }
    },
    async prepareDraft({ contactId, messageId, followup }) {
      const contact = await deps.ghl.getContact(contactId)
      const access = await conversationAccess(db, contactId, contact.phone)
      if (contact.id !== contactId || !access.allowed) throw new Error('conversation held before followup draft')
      const media = followup.photo ? photoUrl(followup.photo) : null
      const draft = await saveDraft(db, { messageId, contactId, phone: contact.phone, inbound: '[scheduled quote followup]',
        reply: followup.line, needsHuman: !media, blocked: media ? [] : ['followup_photo_unavailable'], dealState: 'ESTIMATE_SENT', salesDraft: Boolean(media),
        mediaUrls: media ? [media] : [], photoIds: media && followup.photo ? [followup.photo.id] : [] })
      return { draftId: draft.draft.id }
    },
  }, now, 10, { settings: settings?.followups, photos: settings?.photos })
}
