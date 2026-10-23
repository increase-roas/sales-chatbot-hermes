import { timingSafeEqual } from 'node:crypto'
import { registerApiRoute } from '@mastra/core/server'
import { RequestContext } from '@mastra/core/request-context'
import type { Agent } from '@mastra/core/agent'

import { mannyRuntimeSettings, generationOptions } from '../agents/sales-agent.ts'
import { hasAddress, inferDealState } from '../deal-state.ts'
import { findDraft, latestDraftFor, photosSentTo, recordGrade, saveDraft } from '../drafts.ts'
import { sendDraftToGhl } from '../ghl-send.ts'
import { ghlClient } from '../ghl.ts'
import { graphqlFetcher, jobberClient } from '../jobber.ts'
import { resumeDraftCompletion, type CompletionIntent } from '../draft-completion.ts'
import { applySalesRules, pastQuote, quoteApprovedStop } from '../sales-rules.ts'
import { isTestPhone, parseRating, RATING_ACK, testDestinationOk } from '../test-mode.ts'
import { customerNeedsHuman, guardReply, isOptOut } from '../guard.ts'
import { callContext, callHold, jobberAcceptReply, unsentOnly, verbalYes, type CallRecord } from '../conversation-rules.ts'
import { consentedMedia, limitMedia, photoUrl, photosForSettings, speakerName } from '../photos.ts'
import { examplesBlock, similarRepExamples } from '../rep-examples.ts'
import { ensureAppTables } from '../tables.ts'
import { customerContextFromEnv, customerKnowledgeBlock } from '../customer-context-runtime.ts'
import type { CustomerContext } from '../customer-context.ts'
import { threadLine } from '../text.ts'
import { conversationAccess, normalizedPhone, stopConversation, validateDraftIdentity } from '../conversation-control.ts'

// Draft-only. This route never sends an SMS. sendApprovedDraft is not called here.

function secretMatches(given: string | undefined): boolean {
  const expected = process.env.GHL_WEBHOOK_SECRET
  if (!expected || !given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

type GhlPayload = {
  contact_id?: string
  contactId?: string
  phone?: string
  messageId?: string
  message_id?: string
  contact?: { id?: string; phone?: string }
  message?: string | { id?: string; body?: string }
  body?: string
}

type Sql = {
  none(query: string, values?: unknown[]): Promise<unknown>
  any<T = Record<string, unknown>>(query: string, values?: unknown[]): Promise<T[]>
  oneOrNone<T = Record<string, unknown>>(query: string, values?: unknown[]): Promise<T | null>
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parse(payload: GhlPayload) {
  const messageObject = payload.message && typeof payload.message === 'object' ? payload.message : undefined
  const message = typeof payload.message === 'string' ? payload.message : (messageObject?.body ?? payload.body ?? '')
  const phone = payload.phone ?? payload.contact?.phone ?? ''
  const contactId = payload.contact_id ?? payload.contactId ?? payload.contact?.id ?? ''
  const messageId = textField(payload.messageId) || textField(payload.message_id) || textField(messageObject?.id)
  return { message: textField(message), phone: textField(phone), contactId: textField(contactId), messageId }
}

function dbFrom(storage: unknown): Sql | null {
  if (!storage || typeof storage !== 'object' || !('db' in storage)) return null
  const db = (storage as { db?: Sql }).db
  if (!db || typeof db.none !== 'function' || typeof db.oneOrNone !== 'function') return null
  return db
}

async function priorThread(agent: Agent, resource: string, requestContext: RequestContext) {
  try {
    const memory = await agent.getMemory({ requestContext })
    if (!memory) return ''
    const recalled = await memory.recall({ threadId: `sms-${resource}`, resourceId: resource, perPage: 40 })
    return (recalled.messages ?? []).map(threadLine).filter(Boolean).join('\n')
  } catch {
    return ''
  }
}

const OPT_OUT_REPLY = 'You are opted out. We will not send another sales text.'

export const ghlSmsRoute = registerApiRoute('/webhooks/ghl/sms', {
  method: 'POST',
  requiresAuth: false,
  handler: async c => {
    if (!secretMatches(c.req.header('x-webhook-secret'))) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    let payload: GhlPayload
    try {
      payload = await c.req.json()
    } catch {
      return c.json({ error: 'invalid JSON' }, 400)
    }

    const parsed = parse(payload)
    const { message, contactId, messageId } = parsed
    let phone = parsed.phone
    if (!message || !(phone || contactId)) {
      return c.json({ error: 'message and phone or contact_id are required' }, 400)
    }

    const mastra = c.get('mastra')
    const db = dbFrom(mastra.getStorage())
    const agent = mastra.getAgentById('sales-agent')

    try {
      if (!db) return c.json({ error: 'draft queue unavailable' }, 503)
      await ensureAppTables(db)

      // STOP must persist even when upstream omitted normal draft identifiers.
      if (isOptOut(message)) {
        await stopConversation(db, contactId, phone)
        return c.json({ mode: 'stopped', sent: false, contactId, phone, reply: OPT_OUT_REPLY, needsHuman: false, blocked: ['opt_out'], salesDraft: false })
      }
      if (!validateDraftIdentity(contactId, messageId)) {
        return c.json({ error: 'contactId and messageId are required', code: 'missing_message_identity' }, 400)
      }
      if (messageId) {
        const existing = await findDraft(db, messageId)
        if (existing) {
          const replayVersion = await mannyRuntimeSettings({ mastra, requestContext: new RequestContext() })
          const completion = await resumeDraftCompletion(db, existing, { ghl: ghlClient(), jobber: jobberClient(graphqlFetcher()), knowledge: customerContextFromEnv(process.env, undefined, replayVersion.settings.hindsight) })
          return c.json({
            completion,
            flow: completion?.flow ?? [],
            retentionStatus: completion?.retentionStatus ?? 'not_attempted',
            mode: 'draft',
            sent: false,
            duplicate: true,
            contactId,
            phone,
            reply: existing.reply,
            needsHuman: existing.needs_human,
            blocked: existing.blocked,
            dealState: existing.deal_state,
            salesDraft: existing.sales_draft,
            media: existing.media_urls ?? [],
          })
        }
      }

      const access = await conversationAccess(db, contactId, '')
      if (!access.allowed && access.reason !== 'identity_unresolved') {
        return c.json({ mode: 'held', sent: false, contactId, phone, reply: '', needsHuman: access.reason === 'identity_conflict', blocked: [access.reason], salesDraft: false })
      }
      const testMode = isTestPhone(phone)
      const rating = testMode ? parseRating(message) : null
      if (rating) {
        const last = await latestDraftFor(db, phone)
        if (last) await recordGrade(db, { draftId: last.id, ...rating })
        return c.json({ mode: 'rating', sent: false, contactId, phone, grade: rating.grade, draftId: last?.id ?? null, reply: RATING_ACK[rating.grade] })
      }

      // Hard stop: never text a contact whose Jobber quote is approved (or tagged/staged as approved).
      const ghl = ghlClient()
      const jobber = jobberClient(graphqlFetcher())
      const contact = ghl && contactId ? await ghl.getContact(contactId).catch(() => null) : null
      const authoritativePhone = contact?.phone ?? ''
      if (contact && (contact.id !== contactId || (phone && normalizedPhone(phone) !== normalizedPhone(authoritativePhone)))) {
        return c.json({ mode: 'held', sent: false, contactId, phone, blocked: ['identity_conflict'], salesDraft: false })
      }
      if (!contact || !normalizedPhone(authoritativePhone)) return c.json({ mode: 'held', sent: false, contactId, phone, blocked: ['identity_unresolved'], salesDraft: false })
      phone ||= authoritativePhone
      const resolvedAccess = await conversationAccess(db, contactId, phone)
      if (!resolvedAccess.allowed) return c.json({ mode: 'held', sent: false, contactId, phone, blocked: [resolvedAccess.reason], salesDraft: false })
      const resource = phone
      const jobberStatus = await jobber.quoteStatusForPhone(phone)
      const stop = quoteApprovedStop({ jobberStatus, tags: contact?.tags ?? [] }, false)
      if (stop.stop) {
        return c.json({ mode: 'stopped', sent: false, contactId, phone, reply: '', needsHuman: false, blocked: [stop.reason], salesDraft: false })
      }

      const requestContext = new RequestContext()
      const version = await mannyRuntimeSettings({ mastra, requestContext })
      const settings = version.settings

      // A live or just-finished call: the person on the phone owns the conversation, so the bot waits.
      // A failed lookup is not "no calls": hold rather than draft over a call we can't see.
      let calls: CallRecord[] = []
      // With GHL configured, call state is unknown until a lookup succeeds (no contact id or an error: hold).
      // Without GHL the bot can't send at all, so drafts carry on with no call context.
      let callsUnavailable = Boolean(ghl)
      if (ghl && contactId) {
        try {
          calls = await ghl.getCalls(contactId)
          callsUnavailable = false
        } catch {
          callsUnavailable = true
        }
      }
      const hold = callsUnavailable ? { hold: true, reason: 'call_state_unavailable' } : callHold(calls, new Date(), settings.followups.callCooldownMinutes)
      if (hold.hold) {
        return c.json({ mode: 'held', sent: false, contactId, phone, reply: '', needsHuman: false, blocked: [hold.reason], salesDraft: false })
      }

      const prior = await priorThread(agent, resource, requestContext)
      const dealState = inferDealState(prior, message)
      // A quote already out in Jobber counts too: never restart the quote pitch on it.
      const postQuote = pastQuote(`${prior}\n${message}`) || jobberStatus === 'sent'
      const addressKnown = hasAddress(prior, message) || Boolean(contact?.address) || jobberStatus === 'sent' || jobberStatus === 'draft' || postQuote
      let draft = ''
      let generationFailed = false
      let photoId = ''
      let knowledge: CustomerContext | null = null
      let knowledgeStatus: 'disabled' | 'loading' | 'ready' | 'unavailable' = 'disabled'
      // Verbal yes while a Jobber quote is out: the only move left is approving it in Jobber, no more selling.
      const acceptOnly = jobberStatus === 'sent' && verbalYes(message)
      if (customerNeedsHuman(message)) {
        draft = ''
      } else if (acceptOnly) {
        // UNVERIFIED client-hub link field; until the bot's Jobber grant lands, Marvin sends the link.
        draft = jobberAcceptReply('')
      } else {
        requestContext.set('dealState', dealState)
        requestContext.set('photosSent', await photosSentTo(db, phone).catch(() => []))
        // Alex's own test number may see consent-pending photos (they are his uploads); customers never do.
        requestContext.set('photoIncludePending', testMode)
        requestContext.set('customerTurns', prior.split('\n').filter(l => /^customer:/i.test(l)).length + 1)
        requestContext.set('leadKey', resource)
        requestContext.set('speakerName', speakerName(prior.split('\n').filter(l => /^rep:/i.test(l)).join('\n')))
        // Real rep replies from closed deals in similar moments (eval: 4.09 vs 3.96 without, 2026-10-15).
        // One system message only: a second one breaks this Qwen template's tool steps, so extend instructions.
        let examples = ''
        try {
          if (settings.memory.repExamplesEnabled) examples = examplesBlock(await similarRepExamples(db, message, settings.memory.repExamplesCount))
        } catch (error) {
          console.error('rep example lookup failed', error instanceof Error ? error.message : 'unknown')
        }
        try {
          let companyKnowledge = ''
          knowledgeStatus = process.env.HINDSIGHT_ENABLED === 'true' && settings.hindsight.enabled ? 'loading' : 'disabled'
          knowledge = customerContextFromEnv(process.env, undefined, settings.hindsight)
          if (knowledge) {
            companyKnowledge = customerKnowledgeBlock((await knowledge.start('sales-rules')).text)
            knowledgeStatus = 'ready'
          }
          const result = await agent.generate(`Prospect phone: ${phone || 'unknown'}\n\n${message}`, {
            memory: { resource, thread: `sms-${resource}` },
            requestContext,
            ...generationOptions(settings),
            instructions: [settings.instructions, `Your name in this conversation: ${requestContext.get('speakerName')}.`, callContext(calls, new Date()), examples, companyKnowledge].filter(Boolean).join('\n\n'),
          })
          draft = result.text ?? ''
          photoId = (requestContext.get('photoPicked') as string | undefined) ?? ''
        } catch (error) {
          console.error('sales draft generation failed', error instanceof Error ? error.message : 'unknown')
          // No stand-in sales line: an outage must not look like a normal draft.
          if (knowledgeStatus === 'loading') knowledgeStatus = 'unavailable'
          generationFailed = true
        }
      }

      const base = generationFailed
        ? { reply: '', blocked: [knowledgeStatus === 'unavailable' ? 'company_context_unavailable' : 'generation_failed'], needsHuman: true }
        : guardReply(message, draft, prior)
      // The Jobber accept line is terminal: no address ask or other sales rewrite after it.
      const ruled = base.needsHuman || acceptOnly ? { reply: base.reply, blocked: [] as string[] } : applySalesRules(message, base.reply, addressKnown, postQuote)
      const guarded = { ...base, reply: ruled.reply, blocked: [...base.blocked, ...ruled.blocked] }
      const salesDraft = !guarded.needsHuman
      // A guard rewrite replaces the model's words, so the photo it chose no longer fits.
      const rewritten = guarded.blocked.some(b => b !== 'dash')
      const photo = salesDraft && !rewritten ? photosForSettings(settings.photos).find(p => p.id === photoId) : undefined
      // Never the same photo twice to one contact (07 and 14 are the same image).
      const alreadySent = phone ? await photosSentTo(db, phone).catch(() => [] as string[]) : []
      const freshPhoto = photo && unsentOnly([photo.id], alreadySent).length ? photo : undefined
      const mediaUrls = limitMedia(freshPhoto ? [photoUrl(freshPhoto) ?? ''] : [])
      // Ownership may change while the model is running. Persist a held draft and no effects.
      const finalAccess = await conversationAccess(db, contactId, phone)
      if (!finalAccess.allowed) {
        guarded.reply = ''
        guarded.needsHuman = true
        guarded.blocked.push(finalAccess.reason ?? 'human_owned')
      }
      const finalSalesDraft = salesDraft && finalAccess.allowed
      const completionIntent: CompletionIntent | undefined = finalSalesDraft ? {
        status: 'pending',
        ...(dealState === 'CONFIRMED' ? { handoff: { contactId, name: contact?.name ?? '', phone, email: contact?.email, address: contact?.address || message } } : {}),
        ...(knowledge && !generationFailed ? { memory: { eventId: messageId, outcome: dealState === 'CONFIRMED' ? 'quote_requested' as const : 'draft_created' as const, dealState, photoUsed: mediaUrls.length > 0 } } : {}),
      } : undefined
      const stored = await saveDraft(db, {
        messageId,
        contactId,
        phone,
        inbound: message,
        reply: guarded.reply,
        needsHuman: guarded.needsHuman,
        blocked: guarded.blocked,
        dealState,
        salesDraft: finalSalesDraft,
        completionIntent,
        mediaUrls: finalSalesDraft ? mediaUrls : [],
        photoIds: finalSalesDraft && mediaUrls.length && freshPhoto ? [freshPhoto.id] : [],
      })
      const completion = await resumeDraftCompletion(db, stored.draft, { ghl, jobber, knowledge })
      const flow = completion?.flow ?? []
      const retentionStatus = completion?.retentionStatus ?? 'not_attempted'

      // Test mode: the bot texts Alex's test number back for real, so he can rate it in the thread.
      let sent = false
      // Both switches: test-mode sending never bypasses the global send flag (Codex r3).
      if (testMode && finalSalesDraft && !stored.duplicate && process.env.GHL_TEST_SEND_ENABLED === 'true' && process.env.GHL_SEND_ENABLED === 'true' && contactId) {
        // Re-check right before sending: identity first, then the quote stop. Alex's test number is not a
        // customer, so only a known approval stops it there; customer sends fail closed (sendApprovedDraft).
        const freshContact = ghl ? await ghl.getContact(contactId).catch(() => null) : null
        const freshStop = quoteApprovedStop({ jobberStatus: await jobber.quoteStatusForPhone(phone), tags: freshContact?.tags ?? [] }, false)
        const sendAccess = freshContact ? await conversationAccess(db, contactId, freshContact.phone) : { allowed: false }
        if (freshContact?.id === contactId && sendAccess.allowed && testDestinationOk(phone, freshContact.phone) && !freshStop.stop) {
          const out = await sendDraftToGhl({ contactId, reply: stored.draft.reply, mediaUrls: consentedMedia(stored.draft.media_urls ?? [], true, photosForSettings(settings.photos)) }, { enabled: process.env.GHL_SEND_ENABLED === 'true' })
          sent = out.sent
        }
      }

      return c.json({
        settingsVersionId: version.id,
        mode: sent ? 'sent' : 'draft',
        sent,
        flow,
        completion,
        knowledgeStatus,
        retentionStatus,
        duplicate: stored.duplicate,
        contactId,
        phone,
        reply: stored.draft.reply,
        needsHuman: stored.draft.needs_human,
        blocked: stored.draft.blocked,
        dealState: stored.draft.deal_state,
        salesDraft: stored.draft.sales_draft,
        media: stored.draft.media_urls ?? [],
      })
    } catch {
      return c.json({ error: 'draft queue or conversation dependency unavailable' }, 503)
    } finally {
      // Vercel freezes the function on return. The deployer does not flush traces.
      await mastra.observability.flush()
    }
  },
})
