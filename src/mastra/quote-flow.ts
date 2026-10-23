import { MARVIN_USER_ID, QUOTE_REQUESTED_TAG, type GhlClient } from './ghl.ts'
import type { JobberClient } from './jobber.ts'
import { runDurableEffect, type DurableWorkStore } from './durable-work.ts'

// Alex 2026-10-15: on YES + address -> tag "quote requested", create the Jobber quote, and give Marvin a task
// to call, send the quote from Jobber by email and text, then text the mockup (links in the task notes).
// Each step is its own switch so it can stay off where an existing GHL workflow ("Needs quote - tag") already
// does it. All default OFF; turning one on is a live write and needs Alex's yes.
export type FlowSwitches = { tag: boolean; jobberQuote: boolean; marvinTask: boolean }

export function flowSwitches(env: Record<string, string | undefined> = process.env): FlowSwitches {
  return { tag: env.FLOW_TAG === 'true', jobberQuote: env.FLOW_JOBBER_QUOTE === 'true', marvinTask: env.FLOW_MARVIN_TASK === 'true' }
}

export type QuoteRequest = { contactId: string; name: string; phone: string; email?: string; address: string; mockupUrl?: string }
export type FlowStep = { step: 'tag' | 'jobber_quote' | 'marvin_task'; done: boolean; detail: string }

export function marvinTaskText(req: QuoteRequest, quoteUrl: string): { title: string; body: string } {
  return {
    title: `Call ${req.name || 'new lead'}: holiday lights quote requested`,
    body: [
      `${req.name || 'Lead'} said yes to a holiday lights quote (rooflines). Address: ${req.address}`,
      `Phone: ${req.phone}${req.email ? `  Email: ${req.email}` : ''}`,
      '',
      '1. Call them.',
      '2. In Jobber, send the quote by email AND text.',
      '3. Text them the mockup photo (link below, copy and paste it into the message).',
      '',
      `Jobber quote: ${quoteUrl || '(not created yet: create it in Jobber)'}`,
      `Mockup photo: ${req.mockupUrl || '(add the mockup link here when it is ready)'}`,
    ].join('\n'),
  }
}

export async function runQuoteRequestedFlow(
  req: QuoteRequest,
  deps: JournaledDeps,
): Promise<FlowStep[]> {
  return runJournaledQuoteFlow(req, deps)
}

type JournaledDeps = {
  ghl: GhlClient | null; jobber: JobberClient | null; switches: FlowSwitches; now?: Date
  journal: { store: DurableWorkStore; conversationId: string }
  access: () => Promise<{ allowed: boolean; reason?: string }>
}

// One effect key per confirmed conversation; replay keeps provider receipts, never repeats uncertain work.
async function runJournaledQuoteFlow(req: QuoteRequest, deps: JournaledDeps): Promise<FlowStep[]> {
  if (!deps.journal.conversationId.trim() || !req.contactId.trim()) throw new Error('confirmed conversation identity required')
  const steps: FlowStep[] = []
  let quoteUrl = ''
  const effects: Array<{ step: FlowStep['step']; enabled: boolean; available: boolean; dispatch: () => Promise<{ providerId: string; url?: string }> }> = [
    { step: 'tag', enabled: deps.switches.tag, available: Boolean(deps.ghl), dispatch: async () => {
      await deps.ghl!.addTags(req.contactId, [QUOTE_REQUESTED_TAG])
      // Tagging has no action ID; the provider contact ID plus readback identifies its resulting state.
      const contact = await deps.ghl!.getContact(req.contactId)
      return { providerId: contact.id === req.contactId && contact.tags.includes(QUOTE_REQUESTED_TAG) ? `${contact.id}:${QUOTE_REQUESTED_TAG}` : '' }
    } },
    { step: 'jobber_quote', enabled: deps.switches.jobberQuote, available: Boolean(deps.jobber), dispatch: async () => {
      const quote = await deps.jobber!.createQuote({ name: req.name, phone: req.phone, email: req.email, address: req.address, note: 'Holiday lights: roofline. Requested by text.' })
      return { providerId: quote.id, url: quote.url }
    } },
    { step: 'marvin_task', enabled: deps.switches.marvinTask, available: Boolean(deps.ghl), dispatch: async () => {
      const due = new Date((deps.now ?? new Date()).getTime() + 2 * 3600_000).toISOString()
      const { title, body } = marvinTaskText(req, quoteUrl)
      const task = await deps.ghl!.createTask(req.contactId, { title, body, assignedTo: MARVIN_USER_ID, dueDate: due })
      return { providerId: task.id }
    } },
  ]
  for (const effect of effects) {
    if (!effect.enabled) { steps.push({ step: effect.step, done: false, detail: 'switch off' }); continue }
    if (!effect.available) { steps.push({ step: effect.step, done: false, detail: effect.step === 'jobber_quote' ? 'Jobber client unavailable' : 'GHL client unavailable' }); break }
    const access = await deps.access()
    if (!access.allowed) { steps.push({ step: effect.step, done: false, detail: access.reason ?? 'human_owned' }); break }
    const result = await runDurableEffect(deps.journal.store, {
      source_key: `handoff:${encodeURIComponent(req.contactId)}:${encodeURIComponent(deps.journal.conversationId)}:${effect.step}`,
      kind: 'quote_handoff', contact_id: req.contactId, due_at: deps.now ?? new Date(), payload: { step: effect.step },
    }, effect.dispatch)
    steps.push({ step: effect.step, done: result.status === 'completed', detail: result.status === 'completed' ? String(result.receipt!.providerId) : result.status })
    if (effect.step === 'jobber_quote' && typeof result.receipt?.url === 'string') quoteUrl = result.receipt.url
    if (result.status !== 'completed') break
  }
  return steps
}
