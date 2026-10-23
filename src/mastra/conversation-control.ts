import { ensureAppTables } from './tables.ts'

export type ControlSql = {
  none(query: string, values?: unknown[]): Promise<unknown>
  oneOrNone<T = Record<string, unknown>>(query: string, values?: unknown[]): Promise<T | null>
}
type State = { owner: 'human' | 'bot'; stopped: boolean; identity_hold: boolean }
export type ConversationAccess = { allowed: boolean; reason?: string }

export function normalizedPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  return digits.length >= 11 && digits.length <= 15 ? `+${digits}` : ''
}
export function validateDraftIdentity(contactId: string, messageId: string): boolean {
  return Boolean(contactId.trim() && messageId.trim())
}
async function ensureContact(db: ControlSql, contactId: string) {
  await ensureAppTables(db)
  await db.none(`/* control:ensure */ INSERT INTO sms_conversation_control (contact_id) VALUES ($1) ON CONFLICT (contact_id) DO NOTHING`, [contactId])
}
async function bindPhone(db: ControlSql, contactId: string, phone: string): Promise<boolean> {
  // The conflict update locks the existing alias and returns its original owner; never reassign it.
  const alias = await db.oneOrNone<{ contact_id: string }>(`/* control:alias */
    INSERT INTO sms_phone_aliases (phone, contact_id) VALUES ($1, $2)
    ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone RETURNING contact_id`, [phone, contactId])
  if (!alias) throw new Error('phone alias persistence failed')
  if (alias.contact_id === contactId) return true
  await db.none(`/* control:hold */ UPDATE sms_conversation_control SET identity_hold = true, updated_at = now() WHERE contact_id = ANY($1::text[])`, [[contactId, alias.contact_id]])
  return false
}
export async function stopConversation(db: ControlSql, contactId: string, rawPhone: string): Promise<void> {
  const phone = normalizedPhone(rawPhone)
  if (contactId) {
    await ensureContact(db, contactId)
    // STOP is persisted before attempting phone reconciliation, which can hold the identity.
    await db.none(`/* control:stop */ UPDATE sms_conversation_control SET stopped = true, updated_at = now() WHERE contact_id = $1`, [contactId])
  }
  if (phone) {
    await ensureAppTables(db)
    await db.none(`/* control:phone-stop */ INSERT INTO sms_opt_outs (phone, contact_id, reason) VALUES ($1, $2, 'stop') ON CONFLICT (phone) DO NOTHING`, [phone, contactId])
    if (contactId) await bindPhone(db, contactId, phone)
  }
}
export async function conversationAccess(db: ControlSql, contactId: string, rawPhone: string): Promise<ConversationAccess> {
  if (!contactId.trim()) return { allowed: false, reason: 'identity_unresolved' }
  await ensureContact(db, contactId)
  const phone = normalizedPhone(rawPhone)
  const bound = phone ? await bindPhone(db, contactId, phone) : true
  // Match historic unnormalized optouts too; new writes are canonical E.164-like aliases.
  const optedOut = phone ? await db.oneOrNone(`/* control:optout */ SELECT phone FROM sms_opt_outs
    WHERE phone = $1 OR regexp_replace(phone, '[^0-9]', '', 'g') = substring($1 from 2)
    OR ('1' || regexp_replace(phone, '[^0-9]', '', 'g')) = substring($1 from 2) LIMIT 1`, [phone]) : null
  if (optedOut) await stopConversation(db, contactId, phone)
  const state = await db.oneOrNone<State>(`/* control:state */ SELECT owner, stopped, identity_hold FROM sms_conversation_control WHERE contact_id = $1`, [contactId])
  if (!state) throw new Error('conversation state unavailable')
  if (state.stopped) return { allowed: false, reason: 'opt_out' }
  if (!bound || state.identity_hold) return { allowed: false, reason: 'identity_conflict' }
  if (state.owner === 'human') return { allowed: false, reason: 'human_owned' }
  if (!phone) return { allowed: false, reason: 'identity_unresolved' }
  return { allowed: true }
}
export async function setConversationOwner(db: ControlSql, contactId: string, owner: 'human' | 'bot', phone = ''): Promise<void> {
  await ensureContact(db, contactId)
  const canonical = normalizedPhone(phone)
  if (canonical) await bindPhone(db, contactId, canonical)
  // Resume only changes ownership. STOP and reconciliation holds are terminal here.
  await db.none(`/* control:owner */ UPDATE sms_conversation_control SET owner = $2, updated_at = now() WHERE contact_id = $1`, [contactId, owner])
}
export async function controlConversation(authenticated: boolean, db: ControlSql | null, body: unknown) {
  if (!authenticated) return { status: 401 as const, body: { error: 'unauthorized' } }
  const input = body as Record<string, unknown> | null
  if (!input || typeof input.contactId !== 'string' || !input.contactId.trim() || !['human', 'bot'].includes(String(input.owner)) || (input.phone !== undefined && (typeof input.phone !== 'string' || !normalizedPhone(input.phone)))) {
    return { status: 400 as const, body: { error: 'contactId, owner human|bot and optional valid phone required' } }
  }
  if (!db) return { status: 503 as const, body: { error: 'conversation control unavailable' } }
  const contactId = input.contactId.trim(), owner = input.owner as 'human' | 'bot'
  await setConversationOwner(db, contactId, owner, input.phone as string | undefined)
  return { status: 200 as const, body: { contactId, owner } }
}
