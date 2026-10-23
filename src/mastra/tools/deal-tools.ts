import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

import { gateAction, isDealState, type DealAction, type DealState } from '../deal-state.ts'

const outputSchema = z.object({
  allowed: z.boolean(),
  state: z.string(),
  reason: z.string(),
})

function stateFrom(context: { requestContext?: { get: (key: string) => unknown } } | undefined): DealState {
  const value = context?.requestContext?.get('dealState')
  return isDealState(value) ? value : 'NEW'
}

function dealTool(action: DealAction, id: string, description: string) {
  return createTool({
    id,
    description,
    inputSchema: z.object({
      note: z.string().optional().describe('Why you are asking. Do not put a price or date here.'),
    }),
    outputSchema,
    execute: async (_input, context) => gateAction(action, stateFrom(context)),
  })
}

export const quotePrice = dealTool(
  'price',
  'quote-price',
  'Ask whether a price may be repeated. Denied unless the deal is CONFIRMED or ESTIMATE_SENT. Never invent a dollar amount.',
)

export const proposeDate = dealTool(
  'date',
  'propose-date',
  'Ask whether an install date may be repeated. Denied unless the deal is ESTIMATE_SENT. Never invent a date.',
)

export const bookInstall = dealTool(
  'booking',
  'book-install',
  'Ask whether booking is allowed. Denied unless the deal is ESTIMATE_SENT. This does not book anything.',
)
