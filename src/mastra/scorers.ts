import { createScorer } from '@mastra/core/evals'

import { gateAction, inferDealState, type DealState } from './deal-state.ts'
import { claimsMachine, containsDate, containsPrice } from './guard.ts'
import { textOf, threadLine } from './text.ts'

type StageTruth = {
  state?: DealState
  keepPrice?: boolean
  keepDate?: boolean
}

type GateInput = {
  prior?: string
  customer?: string
  inputMessages?: unknown
  rememberedMessages?: unknown
}

function linesOf(value: unknown): string {
  if (Array.isArray(value)) return value.map(threadLine).filter(Boolean).join('\n')
  return textOf(value)
}

function readConversation(input: unknown): { prior: string; customer: string } {
  const gate = (input ?? {}) as GateInput
  if (!gate.inputMessages && !gate.rememberedMessages) {
    return { prior: gate.prior ?? '', customer: gate.customer ?? '' }
  }
  return {
    prior: linesOf(gate.rememberedMessages),
    customer: linesOf(gate.inputMessages),
  }
}

function readReply(output: unknown): string {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object' && 'reply' in output) {
    const reply = (output as { reply?: unknown }).reply
    if (typeof reply === 'string') return reply
  }
  return textOf(output)
}

function introduces(reply: string, known: string, kind: 'price' | 'date'): boolean {
  const has = kind === 'price' ? containsPrice : containsDate
  return has(reply) && !has(known)
}

// Spec for the tool gates. gateAction is the implementation this checks.
function toolsMatchState(state: DealState): boolean {
  const price = state === 'CONFIRMED' || state === 'ESTIMATE_SENT'
  const later = state === 'ESTIMATE_SENT'
  return (
    gateAction('price', state).allowed === price &&
    gateAction('date', state).allowed === later &&
    gateAction('booking', state).allowed === later
  )
}

export const styleScorer = createScorer({
  id: 'sms-style',
  description: 'Short rep-style text: no machine claim, one question at most, SMS length.',
}).generateScore(({ run }) => {
  const reply = readReply(run.output)
  let score = 1
  if (claimsMachine(reply)) score -= 0.5
  if (reply.length > 320) score -= 0.25
  const questions = reply.match(/\?/g)?.length ?? 0
  if (questions > 1) score -= 0.25
  return Math.max(0, score)
})

export const stageTransitionScorer = createScorer({
  id: 'stage-transition',
  description: 'Deal state matches the evidence, and price, date, and booking stay denied until that state allows them.',
}).generateScore(({ run }) => {
  const { prior, customer } = readConversation(run.input)
  const reply = readReply(run.output)
  const state = inferDealState(prior, customer)
  const truth = run.groundTruth as StageTruth | undefined
  if (truth?.state) {
    if (state !== truth.state || !toolsMatchState(state)) return 0
    if (truth.keepPrice && !containsPrice(reply)) return 0
    if (truth.keepDate && !containsDate(reply)) return 0
    return 1
  }
  const known = `${prior}\n${customer}`
  if (introduces(reply, known, 'price') && state !== 'CONFIRMED' && state !== 'ESTIMATE_SENT') return 0
  if (introduces(reply, known, 'date') && state !== 'ESTIMATE_SENT') return 0
  return toolsMatchState(state) ? 1 : 0
})

export const prematurePaymentScorer = createScorer({
  id: 'premature-payment',
  description: 'A reply must not introduce a price that nobody has already said.',
}).generateScore(({ run }) => {
  const { prior, customer } = readConversation(run.input)
  const reply = readReply(run.output)
  return introduces(reply, `${prior}\n${customer}`, 'price') ? 0 : 1
})
