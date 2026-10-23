import { conversationAccess, normalizedPhone } from './conversation-control.ts'
import { customerContextFromEnv } from './customer-context-runtime.ts'
import type { BusinessOutcome, CustomerContext } from './customer-context.ts'
import { ensureDurableWorkTables, PgDurableWorkStore, runDurableEffect, type DurableWorkStore, type WorkSql } from './durable-work.ts'
import type { GhlClient } from './ghl.ts'
import type { JobberClient } from './jobber.ts'
import { flowSwitches, runQuoteRequestedFlow, type FlowStep, type FlowSwitches, type QuoteRequest } from './quote-flow.ts'

export type CompletionIntent = {
  status: 'pending' | 'held' | 'cancelled' | 'completed' | 'uncertain'
  handoff?: QuoteRequest
  memory?: BusinessOutcome
  flow?: FlowStep[]
  retentionStatus?: string
  reason?: string
}
type CompletionDraft = { id: string; completion_intent?: CompletionIntent | null }
type CompletionDeps = {
  ghl: GhlClient | null; jobber: JobberClient | null
  store?: DurableWorkStore; switches?: FlowSwitches; knowledge?: CustomerContext | null
  access?: () => Promise<{ allowed: boolean; reason?: string }>
}

// The draft INSERT owns intent durability. Child receipts own provider-call recovery; no parent
// dispatch claim is needed, and an interrupted child is never sent a second time.
export async function resumeDraftCompletion(db: WorkSql, draft: CompletionDraft, deps: CompletionDeps): Promise<CompletionIntent | null> {
  if (!draft.completion_intent) return null
  const intent = structuredClone(draft.completion_intent)
  if (intent.status === 'cancelled' || intent.status === 'completed') return intent
  await ensureDurableWorkTables(db)
  const store = deps.store ?? new PgDurableWorkStore(db)
  intent.status = 'pending'
  if (intent.handoff) {
    const req = intent.handoff
    const access = deps.access ?? (async () => {
      const contact = await deps.ghl?.getContact(req.contactId)
      if (!contact || contact.id !== req.contactId || !normalizedPhone(contact.phone) || normalizedPhone(contact.phone) !== normalizedPhone(req.phone)) return { allowed: false, reason: 'identity_unresolved' }
      return conversationAccess(db, req.contactId, contact.phone)
    })
    intent.flow = await runQuoteRequestedFlow(req, { ...deps, switches: deps.switches ?? flowSwitches(), journal: { store, conversationId: `holiday-2026:${req.contactId}` }, access })
    const halted = intent.flow.find(step => !step.done && !step.detail.startsWith('switch off'))
    if (halted) {
      intent.reason = halted.detail
      intent.status = halted.detail === 'opt_out' ? 'cancelled' : ['uncertain', 'dispatching'].includes(halted.detail) ? 'uncertain' : 'held'
    }
  }
  if (intent.memory && intent.status === 'pending') {
    const context = deps.knowledge === undefined ? customerContextFromEnv() : deps.knowledge
    if (!context) { intent.retentionStatus = 'unavailable'; intent.status = 'held' }
    else {
      const outcome = intent.memory
      const result = await runDurableEffect(store, { source_key: `memory:${outcome.eventId}`, kind: 'memory_outcome', contact_id: intent.handoff?.contactId ?? `draft:${draft.id}`, due_at: new Date(), payload: { outcome: outcome.outcome, dealState: outcome.dealState, photoUsed: outcome.photoUsed } }, async () => ({ providerId: (await context.complete(outcome)).operationId ?? '' }))
      intent.retentionStatus = result.status === 'completed' ? 'submitted' : result.status
      if (result.status !== 'completed') intent.status = result.status === 'pending' ? 'pending' : 'uncertain'
    }
  }
  if (intent.status === 'pending' && (!intent.memory || intent.retentionStatus === 'submitted')) intent.status = 'completed'
  const saved = await db.oneOrNone(`UPDATE sms_drafts SET completion_intent = $2 WHERE id = $1 RETURNING id`, [draft.id, intent])
  if (!saved) throw new Error('draft completion state persistence failed')
  return intent
}

export async function resumePendingDraftCompletions(db: WorkSql, deps: CompletionDeps, afterDraftId?: string) {
  const rows = await db.any<CompletionDraft>(`SELECT id, completion_intent FROM sms_drafts
    WHERE completion_intent->>'status' IN ('pending','held','uncertain')
    AND ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT 10`, [afterDraftId ?? null])
  const results = []
  for (const row of rows) {
    try { results.push({ draftId: row.id, completion: await resumeDraftCompletion(db, row, deps) }) }
    catch { results.push({ draftId: row.id, error: 'completion dependency unavailable' }) }
  }
  return results
}
