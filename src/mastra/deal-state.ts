import { containsPrice } from './guard.ts'

// Deal state lives here, not in the model. The model only writes words.
// Price, date, and booking stay denied until the state below allows them.

export const DEAL_STATES = ['NEW', 'QUALIFIED', 'CONFIRMED', 'ESTIMATE_SENT'] as const
export type DealState = (typeof DEAL_STATES)[number]
export type DealAction = 'price' | 'date' | 'booking'

const ADDRESS =
  /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:street|avenue|road|drive|lane|blvd|court|circle|place|st|ave|rd|dr|ln|ct|cir|pl|way)\b/i
const ADDRESS_RETRACT = /\b(address is wrong|wrong address|not my address)\b/i
const CONFIRM = /\b(yes|yep|yeah|confirmed|that is right|that's right|thats right|send the estimate|go ahead|let's do it|lets do it)\b/i
const UNCONFIRM =
  /\b(do not book|don't book|dont book|actually no|wait no|never mind|nevermind|hold off|not ready|address is wrong|wrong address|not my house|photo is not)\b/i

export function isDealState(value: unknown): value is DealState {
  return typeof value === 'string' && (DEAL_STATES as readonly string[]).includes(value)
}

export function threadEvidence(prior: string, customer: string): { customerText: string; assistantText: string } {
  const customerLines: string[] = []
  const assistantLines: string[] = []
  for (const line of prior.split('\n')) {
    if (/^rep:/i.test(line)) assistantLines.push(line.replace(/^rep:\s*/i, ''))
    else if (/^customer:/i.test(line)) customerLines.push(line.replace(/^customer:\s*/i, ''))
    else if (line.trim()) customerLines.push(line)
  }
  if (customer.trim()) customerLines.push(customer.trim())
  return { customerText: customerLines.join('\n'), assistantText: assistantLines.join('\n') }
}

// Alex 2026-10-15: we never need the lead's photo (we make the mockup), so the address alone qualifies.
// QUALIFIED needs an address. CONFIRMED (= quote requested) needs that plus a clear yes not taken back.
// ESTIMATE_SENT needs a price already said by the rep, not a number the customer is asking for.
export function inferDealState(prior: string, customer: string): DealState {
  const { customerText, assistantText } = threadEvidence(prior, customer)
  const addressOk = ADDRESS.test(customerText) && !ADDRESS_RETRACT.test(customerText)
  const confirmed = CONFIRM.test(customerText) && !UNCONFIRM.test(customerText)
  const estimateSent = containsPrice(assistantText)

  if (addressOk && estimateSent) return 'ESTIMATE_SENT'
  if (addressOk && confirmed) return 'CONFIRMED'
  if (addressOk) return 'QUALIFIED'
  return 'NEW'
}

export function gateAction(action: DealAction, state: DealState): { allowed: boolean; state: DealState; reason: string } {
  const allowed = action === 'price' ? state === 'CONFIRMED' || state === 'ESTIMATE_SENT' : state === 'ESTIMATE_SENT'
  return {
    allowed,
    state,
    reason: allowed
      ? 'Allowed for this deal state. Do not invent a price, date, or booking. Only repeat one already in the thread.'
      : `Denied. Deal state is ${state}. This action stays blocked until the state allows it.`,
  }
}

export function hasAddress(prior: string, customer: string): boolean {
  const { customerText } = threadEvidence(prior, customer)
  return ADDRESS.test(customerText) && !ADDRESS_RETRACT.test(customerText)
}
