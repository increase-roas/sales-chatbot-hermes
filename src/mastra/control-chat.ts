import { Agent } from '@mastra/core/agent'
import { RequestContext } from '@mastra/core/request-context'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { generationOptions, mannyToolsFor } from './agents/sales-agent.ts'
import { pinSavedVersion, type Version } from './control-settings.ts'
import { inferDealState, hasAddress } from './deal-state.ts'
import { guardReply } from './guard.ts'
import { photosForSettings, speakerName } from './photos.ts'
import { applySalesRules, pastQuote } from './sales-rules.ts'
import { resolveSalesModel } from './sales-model.ts'
import { threadLine } from './text.ts'
import { lookupProspect } from './tools/lookup-prospect.ts'

const MAX_TURN_LENGTH = 4000
export const testChatSchema = z.object({
  versionId: z.string().min(1).max(200),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(MAX_TURN_LENGTH), photoId: z.string().max(100).optional() }).strict()).max(30),
  message: z.string().trim().min(1).max(1000),
  conversationId: z.string().min(1).max(100),
}).strict()
export type TestChatInput = z.infer<typeof testChatSchema>

export function testChatAvailability() {
  const configured = Boolean(process.env.FIREWORKS_API_KEY)
  const enabled = process.env.MANNY_CHAT_ENABLED === 'true'
  return { configured, enabled: configured && enabled,
    reason: !configured ? 'Fireworks is not connected to this server.' : !enabled ? 'Real Fireworks test replies are waiting for spend approval.' : 'Ready. Each reply uses Fireworks credits. Nothing is sent to a customer.' }
}

// This uses the selected saved Manny prompt/model/tools and the existing demo's
// reply rules. History lives in the browser; CRM, shared memory and handoffs are
// excluded from this private test. Laya is not synthesized or silently replaced.
export async function runMannyTest(version: Version, input: TestChatInput) {
  const prior = input.history.map(m => threadLine({ role: m.role, content: m.content })).filter(Boolean).join('\n')
  const sent = input.history.flatMap(m => m.photoId ? [m.photoId] : [])
  const context = new RequestContext()
  pinSavedVersion(context, version)
  context.set('dealState', inferDealState(prior, input.message))
  context.set('photosSent', sent)
  context.set('photoIncludePending', false)
  context.set('customerTurns', input.history.filter(m => m.role === 'user').length + 1)
  context.set('leadKey', input.conversationId)
  context.set('speakerName', speakerName(input.history.filter(m => m.role === 'assistant').map(m => m.content).join('\n')))
  const tools = { ...mannyToolsFor(version.settings), ...(version.settings.tools.lookupProspect ? { lookupProspect: createTool({
    id: 'lookup-prospect', description: lookupProspect.description,
    inputSchema: lookupProspect.inputSchema, outputSchema: lookupProspect.outputSchema,
    execute: async () => ({ found: false, name: '', stage: '', notes: ['Private dashboard test: no live CRM contact lookup. Use the conversation supplied.'], opportunities: [] }),
  }) } : {}) }
  const agent = new Agent({ id: 'manny-dashboard-test', name: 'Manny private test',
    model: resolveSalesModel(version.settings.modelId), instructions: version.settings.instructions, tools })
  const messages = input.history.map(({ role, content }) => role === 'user' ? { role: 'user' as const, content } : { role: 'assistant' as const, content })
  const result = await agent.generate([...messages, { role: 'user' as const, content: input.message }], {
    requestContext: context, ...generationOptions(version.settings),
    instructions: `${version.settings.instructions}\n\nYour name in this conversation: ${context.get('speakerName')}.`,
    abortSignal: AbortSignal.timeout(80_000),
  })
  const guarded = guardReply(input.message, result.text ?? '', prior)
  const quoted = pastQuote(`${prior}\n${input.message}`)
  const ruled = guarded.needsHuman ? { reply: guarded.reply, blocked: [] as string[] } : applySalesRules(input.message, guarded.reply, hasAddress(prior, input.message) || quoted, quoted)
  const blocked = [...guarded.blocked, ...ruled.blocked]
  const picked = String(context.get('photoPicked') ?? '')
  const photo = photosForSettings(version.settings.photos).find(p => p.id === picked && p.consent === 'granted')
  const photoId = photo && !sent.includes(photo.id) && !blocked.some(b => b !== 'dash') ? photo.id : ''
  const toolsUsed = (result.steps ?? []).flatMap(step => (step.toolCalls ?? []).map(call => {
    const value = call as { payload?: { toolName?: string }; toolName?: string }
    return value.payload?.toolName ?? value.toolName ?? ''
  })).filter(Boolean)
  // A displayed reply must always be valid history on the following turn.
  const replyTruncated = ruled.reply.length > MAX_TURN_LENGTH
  const reply = replyTruncated ? ruled.reply.slice(0, MAX_TURN_LENGTH - 1).trimEnd() + '…' : ruled.reply
  return { reply, replyTruncated, photoId, blocked, needsHuman: guarded.needsHuman,
    dealState: context.get('dealState'), settingsVersionId: version.id, modelId: version.settings.modelId,
    toolsUsed, usage: result.usage, laya: 'unverified: actual invocation not recovered',
    mode: 'private test; no SMS, CRM changes or shared-memory operations' }
}
