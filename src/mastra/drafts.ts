import type { CompletionIntent } from './draft-completion.ts'
import { sendDraftToGhl, type SendOptions } from './ghl-send.ts'
import { graphqlFetcher, jobberClient, type JobberClient } from './jobber.ts'
import { quoteApprovedStop } from './sales-rules.ts'
import { consentedMedia, photosForSettings, type PhotoSettings } from './photos.ts'
import { ensureAppTables } from './tables.ts'
import { conversationAccess, normalizedPhone } from './conversation-control.ts'
import { ghlClient, type GhlClient } from './ghl.ts'

type Sql = {
  none(query: string, values?: unknown[]): Promise<unknown>
  any<T = Record<string, unknown>>(query: string, values?: unknown[]): Promise<T[]>
  oneOrNone<T = Record<string, unknown>>(query: string, values?: unknown[]): Promise<T | null>
}

export type DraftRow = {
  id: string
  completion_intent?: CompletionIntent | null
  reply: string
  needs_human: boolean
  blocked: string[]
  deal_state: string
  sales_draft: boolean
  media_urls?: string[]
}

export type StoredDraft = {
  duplicate: boolean
  draft: DraftRow
}

// Photos already sent (drafted) to this phone, so the bot never repeats one in a conversation.
export async function photosSentTo(db: Sql, phone: string): Promise<string[]> {
  if (!phone) return []
  await ensureAppTables(db)
  const rows = await db.any<{ id: string }>(
    `SELECT DISTINCT unnest(photo_ids) AS id FROM sms_drafts WHERE phone = $1`,
    [phone],
  )
  return rows.map(row => row.id)
}

// Latest draft sent to this phone (the one a test-mode rating refers to).
export async function latestDraftFor(db: Sql, phone: string): Promise<{ id: string } | null> {
  await ensureAppTables(db)
  return db.oneOrNone<{ id: string }>(
    `SELECT id FROM sms_drafts WHERE phone = $1 AND sales_draft = true ORDER BY created_at DESC LIMIT 1`,
    [phone],
  )
}

export async function findDraft(db: Sql, messageId: string): Promise<DraftRow | null> {
  await ensureAppTables(db)
  return db.oneOrNone<DraftRow>(
    `SELECT id, reply, needs_human, blocked, deal_state, sales_draft, media_urls, completion_intent
     FROM sms_drafts WHERE ghl_message_id = $1`,
    [messageId],
  )
}

export async function saveDraft(
  db: Sql,
  input: {
    messageId: string
    contactId: string
    phone: string
    inbound: string
    reply: string
    needsHuman: boolean
    blocked: string[]
    dealState: string
    salesDraft: boolean
    mediaUrls?: string[]
    completionIntent?: CompletionIntent
    photoIds?: string[]
  },
): Promise<StoredDraft> {
  await ensureAppTables(db)
  const messageId = input.messageId || null
  const inserted = await db.oneOrNone<DraftRow>(
    `INSERT INTO sms_drafts
       (ghl_message_id, contact_id, phone, inbound_text, reply, needs_human, blocked, deal_state, sales_draft, media_urls, photo_ids, completion_intent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (ghl_message_id) DO NOTHING
     RETURNING id, reply, needs_human, blocked, deal_state, sales_draft, media_urls, completion_intent`,
    [
      messageId,
      input.contactId,
      input.phone,
      input.inbound,
      input.reply,
      input.needsHuman,
      input.blocked,
      input.dealState,
      input.salesDraft,
      input.mediaUrls ?? [],
      input.photoIds ?? [],
      input.completionIntent ?? null,
    ],
  )
  if (inserted) return { duplicate: false, draft: inserted }
  const existing = messageId ? await findDraft(db, messageId) : null
  if (!existing) throw new Error('draft insert did not return a row')
  return { duplicate: true, draft: existing }
}

export async function isOptedOut(db: Sql, phone: string): Promise<boolean> {
  if (!phone) return false
  await ensureAppTables(db)
  const row = await db.oneOrNone<{ phone: string }>(`SELECT phone FROM sms_opt_outs WHERE phone = $1`, [phone])
  return Boolean(row)
}

export async function recordOptOut(db: Sql, phone: string, contactId: string, reason: string): Promise<void> {
  await ensureAppTables(db)
  await db.none(
    `INSERT INTO sms_opt_outs (phone, contact_id, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (phone) DO NOTHING`,
    [phone, contactId, reason],
  )
}

export type Grade = 'approve' | 'edit' | 'reject'

// Called by a person grading a draft. The webhook never calls this, and it never invents a grade.
export async function recordGrade(
  db: Sql,
  input: { draftId: string; grade: Grade; editedReply?: string },
): Promise<{ id: string }> {
  await ensureAppTables(db)
  if (input.grade === 'edit' && !input.editedReply?.trim()) {
    throw new Error('an edit grade needs the rewritten reply')
  }
  const row = await db.oneOrNone<{ id: string }>(
    `INSERT INTO sms_grades (draft_id, grade, edited_reply)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [input.draftId, input.grade, input.editedReply?.trim() || null],
  )
  if (!row) throw new Error('grade insert did not return a row')
  return row
}

// Sends an approved draft (text + its photo) through GHL when GHL_SEND_ENABLED=true. Off by default:
// live SMS needs A2P 10DLC and Alex's yes. The webhook never calls this.
export async function sendApprovedDraft(
  db: Sql,
  draftId: string,
  opts: SendOptions & { jobber?: JobberClient; tags?: string[]; photoSettings?: PhotoSettings; ghl?: Pick<GhlClient, 'getContact'> } = {},
): Promise<{ sent: boolean; mode: 'draft' | 'sent'; reason?: string; messageId?: string }> {
  await ensureAppTables(db)
  const row = await db.oneOrNone<{ contact_id: string; phone: string; reply: string; media_urls: string[] | null }>(
    `SELECT sms_drafts.contact_id, sms_drafts.phone, sms_drafts.reply, sms_drafts.media_urls
     FROM sms_grades
     JOIN sms_drafts ON sms_drafts.id = sms_grades.draft_id
     WHERE sms_drafts.id = $1 AND sms_grades.grade = 'approve'
     LIMIT 1`,
    [draftId],
  )
  if (!row) return { sent: false, mode: 'draft', reason: 'This draft has no approve grade.' }
  const ghl = opts.ghl ?? ghlClient()
  const contact = ghl ? await ghl.getContact(row.contact_id).catch(() => null) : null
  if (!contact || contact.id !== row.contact_id || !normalizedPhone(contact.phone) || normalizedPhone(contact.phone) !== normalizedPhone(row.phone)) {
    const status = await (opts.jobber ?? jobberClient(graphqlFetcher())).quoteStatusForPhone(row.phone)
    const terminal = quoteApprovedStop({ jobberStatus: status, tags: opts.tags ?? [] }, true)
    return { sent: false, mode: 'draft', reason: terminal.stop ? terminal.reason : 'identity_unresolved' }
  }
  const access = await conversationAccess(db, row.contact_id, contact.phone)
  if (!access.allowed) return { sent: false, mode: 'draft', reason: access.reason }
  // Hard stop before every send, fail closed: an approved or unknown Jobber quote means no text.
  const jobberStatus = await (opts.jobber ?? jobberClient(graphqlFetcher())).quoteStatusForPhone(contact.phone)
  const stop = quoteApprovedStop({ jobberStatus, tags: contact.tags }, true)
  if (stop.stop) return { sent: false, mode: 'draft', reason: stop.reason }
  const finalAccess = await conversationAccess(db, row.contact_id, contact.phone)
  if (!finalAccess.allowed) return { sent: false, mode: 'draft', reason: finalAccess.reason }
  const result = await sendDraftToGhl({ contactId: row.contact_id, reply: row.reply, mediaUrls: consentedMedia(row.media_urls ?? [], false, photosForSettings(opts.photoSettings)) }, opts)
  return result.sent
    ? { sent: true, mode: 'sent', messageId: result.messageId }
    : { sent: false, mode: 'draft', reason: result.reason }
}
