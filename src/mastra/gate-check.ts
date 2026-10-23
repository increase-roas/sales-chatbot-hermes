import { guardReply } from './guard.ts'
import { prematurePaymentScorer, stageTransitionScorer, styleScorer } from './scorers.ts'
import type { DealState } from './deal-state.ts'

type GoldenCase = {
  id: string
  prior: string
  customer: string
  badDraft: string
  expected: DealState
  keepPrice?: boolean
  keepDate?: boolean
}

// Adversarial set: skips ahead, demands a price, and takes back what it just said.
const GOLDEN: GoldenCase[] = [
  {
    id: 'skips-to-booking',
    prior: '',
    customer: 'Skip the questions and book me for Saturday. Charge the card.',
    badDraft: 'You are booked Saturday. The total is $899.',
    expected: 'NEW',
  },
  {
    id: 'price-immediately',
    prior: '',
    customer: 'What is the price? I need a number right now.',
    badDraft: 'It is $750 for the front of the house.',
    expected: 'NEW',
  },
  {
    id: 'contradicts',
    prior: 'Customer: Address is 10 Oak Ave. Photo of the front is attached. Light the roofline.',
    customer: 'Actually no, that photo is not my house and the address is wrong. Do not book anything.',
    badDraft: 'You are confirmed. Deposit is $200.',
    expected: 'NEW',
  },
  {
    id: 'qualified-no-price',
    prior: '',
    customer: 'Address is 10 Oak Ave. Photo of the front is attached. Please light the roofline and the bushes.',
    badDraft: 'Great, the quote is $1,100.',
    expected: 'QUALIFIED',
  },
  {
    id: 'confirmed-no-invented-price',
    prior: 'Customer: Address is 10 Oak Ave. Photo of the front is attached. Light the roofline.',
    customer: 'Yes that is right, please send the estimate.',
    badDraft: 'I will get the estimate over. I do not have a number yet.',
    expected: 'CONFIRMED',
  },
  {
    id: 'estimate-already-in-thread',
    prior: 'Customer: Address is 10 Oak Ave. Photo of the front is attached. Light the roofline.\nRep: The estimate is $1,200.',
    customer: 'Can you repeat the estimate?',
    badDraft: 'The estimate is $1,200 for the roofline.',
    expected: 'ESTIMATE_SENT',
    keepPrice: true,
  },
  {
    id: 'date-already-in-thread',
    prior:
      'Customer: Address is 10 Oak Ave. Photo of the front is attached. Light the roofline.\nRep: The estimate is $1,200. Install is October 14.',
    customer: 'What day did you say?',
    badDraft: 'Install is October 14. The estimate is still $1,200.',
    expected: 'ESTIMATE_SENT',
    keepPrice: true,
    keepDate: true,
  },
]

export type GateReport = {
  stageTransitionAccuracy: number
  prematurePaymentRate: number
  styleScore: number
  cases: number
}

export async function evaluateGates(): Promise<GateReport> {
  let stage = 0
  let leaked = 0
  let style = 0
  for (const item of GOLDEN) {
    const guarded = guardReply(item.customer, item.badDraft, item.prior)
    const stageResult = await stageTransitionScorer.run({
      input: { prior: item.prior, customer: item.customer },
      output: { reply: guarded.reply },
      groundTruth: { state: item.expected, keepPrice: item.keepPrice, keepDate: item.keepDate },
    })
    const paymentResult = await prematurePaymentScorer.run({
      input: { prior: item.prior, customer: item.customer },
      output: { reply: guarded.reply },
    })
    const styleResult = await styleScorer.run({
      input: { prior: item.prior, customer: item.customer },
      output: { reply: guarded.reply },
    })
    stage += stageResult.score ?? 0
    if ((paymentResult.score ?? 0) === 0) leaked += 1
    style += styleResult.score ?? 0
  }
  const cases = GOLDEN.length
  return {
    stageTransitionAccuracy: stage / cases,
    prematurePaymentRate: leaked / cases,
    styleScore: style / cases,
    cases,
  }
}
