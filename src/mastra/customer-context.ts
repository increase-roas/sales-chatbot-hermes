import { createHash } from 'node:crypto'
import { z } from 'zod'

export const DYNAMITE_COMPANY_ID = 'f63a396b-956e-42ca-9916-88d98f4a54fe'
const profileSchema = z.object({
  companyId: z.uuid(),
  bankId: z.string(),
  pageIds: z.array(z.string().min(1).max(128)).max(3),
}).strict().refine(p => p.bankId === `paperclip::${p.companyId}`, 'company bank mismatch')
const outcomeSchema = z.object({
  eventId: z.string().min(1).max(256),
  outcome: z.enum(['draft_created', 'quote_requested', 'human_handoff', 'quote_approved', 'reply_graded']),
  dealState: z.enum(['NEW', 'QUALIFIED', 'CONFIRMED', 'ESTIMATE_SENT']),
  photoUsed: z.boolean(),
}).strict()
export type BusinessOutcome = z.infer<typeof outcomeSchema>
export type CustomerProfile = z.infer<typeof profileSchema>
export type KnowledgePage = { id: string; name: string; content: string }
export type KnowledgeTransport = {
  listPages(): Promise<{ id: string; name: string }[]>
  getPage(id: string): Promise<KnowledgePage>
  recall(query: string): Promise<string>
  retain(document: { content: string; documentId: string; tags: string[] }): Promise<{ operationId?: string }>
}
const topics = {
  'sales-rules': 'What are the current holiday lighting sales rules, supported offers, photo rules and human handoff requirements?',
  'quote-handoff': 'What is the verified process for handing a requested quote to the human quote owner?',
  'coaching': 'What reply outcomes and human feedback patterns have been observed? Distinguish hypotheses from proven rules.',
} as const
export type KnowledgeTopic = keyof typeof topics
export const knowledgeTopicSchema = z.enum(Object.keys(topics) as [KnowledgeTopic, ...KnowledgeTopic[]])
export function createCustomerContext(profileInput: CustomerProfile, transport: KnowledgeTransport) {
  const profile = profileSchema.parse(profileInput)
  return {
    profile,
    async start(topic: KnowledgeTopic) {
      if (!(topic in topics)) throw new Error('unknown knowledge topic')
      const available = await transport.listPages()
      const chunks: string[] = []
      for (const id of profile.pageIds) {
        if (!available.some(p => p.id === id)) throw new Error('configured knowledge page missing')
        const page = await transport.getPage(id)
        if (page.id !== id) throw new Error('knowledge page identity mismatch')
        chunks.push(`Page ${page.name}:\n${page.content.slice(0, 2400)}`)
      }
      const recalled = await transport.recall(topics[topic])
      chunks.push(`Targeted recall:\n${recalled.slice(0, 2400)}`)
      return { bankId: profile.bankId, text: chunks.join('\n\n').slice(0, 9000) }
    },
    async complete(input: BusinessOutcome) {
      const result = outcomeSchema.safeParse(input)
      if (!result.success) throw new Error('invalid business outcome field')
      const outcome = result.data
      const documentId = `sales:${createHash('sha256').update(`${profile.companyId}:${outcome.eventId}`).digest('hex')}`
      return transport.retain({
        documentId,
        content: `Sales workflow outcome: ${outcome.outcome}. Deal stage: ${outcome.dealState}. Approved library photo included in draft: ${outcome.photoUsed ? 'yes' : 'no'}. This is draft workflow evidence, not delivery or conversion proof.`,
        tags: ['source:mastra', 'kind:workflow-outcome'],
      })
    },
  }
}
export type CustomerContext = ReturnType<typeof createCustomerContext>
