import type { PhotoSettings } from './photos.ts'
import { nextFollowup, SPACING_HOURS, type FollowupState, type Followup, type FollowupSettings } from './followups.ts'
import type { DurableWorkStore, WorkRow } from './durable-work.ts'

export async function scheduleQuoteFollowups(store: DurableWorkStore, input: { contactId: string; quoteRef: string; quoteSentAt: Date; settings?: FollowupSettings; settingsVersionId?: string }): Promise<WorkRow[]> {
  if (!input.contactId.trim() || !input.quoteRef.trim() || !Number.isFinite(input.quoteSentAt.getTime())) throw new Error('quote identity and sent time required')
  if (input.settings?.enabled === false) return []
  const rows: WorkRow[] = []
  for (const [index, hours] of (input.settings?.spacingHours ?? SPACING_HOURS).entries()) {
    rows.push(await store.enqueue({
      source_key: `followup:${encodeURIComponent(input.contactId)}:${encodeURIComponent(input.quoteRef)}:${index + 1}`,
      kind: 'quote_followup', contact_id: input.contactId,
      due_at: new Date(input.quoteSentAt.getTime() + hours * 3600_000),
      payload: { quoteRef: input.quoteRef, sequence: index + 1, ...(input.settings ? { followupPlan: input.settings, settingsVersionId: input.settingsVersionId } : {}) },
    }))
  }
  return rows
}
export type CurrentFollowup = {
  optedOut: boolean; owner: 'bot' | 'human'; identityResolved: boolean; quoteRef: string
  state: FollowupState
}
export type FollowupRunnerDeps = {
  // Required authoritative read on every claimed task, including STOP/ownership/reply/quote status.
  readCurrent(contactId: string): Promise<CurrentFollowup>
  // Persist with messageId as sms_drafts.ghl_message_id; never send a customer message.
  prepareDraft(input: { contactId: string; messageId: string; followup: Followup }): Promise<{ draftId: string }>
}
export async function runDueQuoteFollowups(store: DurableWorkStore, deps: FollowupRunnerDeps, now: Date = new Date(), limit = 10, options: { settings?: FollowupSettings; photos?: PhotoSettings } = {}): Promise<WorkRow[]> {
  const results: WorkRow[] = []
  if (options.settings?.enabled === false) return results
  const due = await store.due(now, Math.max(1, Math.min(10, Math.trunc(limit) || 10)))
  for (const task of due) {
    const claimed = await store.claim(task.source_key)
    if (!claimed) continue
    // A missing acknowledgement is an operator reconciliation obligation. Later
    // sequences cannot repair it by retrying draft preparation or polling providers.
    let predecessor: WorkRow | null = null
    for (let sequence = 1; sequence < Number(task.payload.sequence); sequence++) {
      const key = `followup:${encodeURIComponent(task.contact_id)}:${encodeURIComponent(String(task.payload.quoteRef))}:${sequence}`
      const prior = await store.get(key)
      if (prior?.status === 'uncertain' || prior?.status === 'cancelled') { predecessor = prior; break }
    }
    if (predecessor) {
      results.push(await store.finish(task.source_key, 'cancelled', { reason: 'prior_followup_requires_reconciliation', predecessor: predecessor.source_key })); continue
    }
    let current: CurrentFollowup
    try { current = await deps.readCurrent(task.contact_id) } catch {
      // No side effect started: retry the required authoritative read on the next internal run.
      results.push(await store.defer(task.source_key, new Date(now.getTime() + 3600_000))); continue
    }
    if (current.optedOut !== false || current.owner !== 'bot' || current.identityResolved !== true ||
      current.quoteRef !== task.payload.quoteRef || current.state.approved !== false || current.state.customerRepliedSince === true || current.state.linesSent.length >= 4) {
      results.push(await store.finish(task.source_key, 'cancelled', { reason: 'current_sales_state_stopped' })); continue
    }
    // A prior sequence is still pending or its draft has not entered authoritative history.
    if (task.payload.sequence !== current.state.linesSent.length + 1) {
      results.push(await store.defer(task.source_key, new Date(now.getTime() + 3600_000))); continue
    }
    const plan = task.payload.followupPlan as FollowupSettings | undefined
    const followup = nextFollowup(current.state, now, { settings: plan ?? options.settings, photos: options.photos })
    if (!followup) {
      results.push(await store.defer(task.source_key, new Date(now.getTime() + 3600_000))); continue
    }
    let receipt: { draftId: string }
    try { receipt = await deps.prepareDraft({ contactId: task.contact_id, messageId: task.source_key, followup }) } catch {
      results.push(await store.finish(task.source_key, 'uncertain', { reason: 'draft_requires_readback' })); continue
    }
    results.push(await store.finish(task.source_key, typeof receipt?.draftId === 'string' && receipt.draftId.trim() ? 'completed' : 'uncertain',
      typeof receipt?.draftId === 'string' && receipt.draftId.trim() ? receipt : { reason: 'missing_draft_id' }))
  }
  return results
}
