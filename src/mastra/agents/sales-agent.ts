import { Agent } from '@mastra/core/agent'
import { ModelRouterEmbeddingModel } from '@mastra/core/llm'
import { Memory } from '@mastra/memory'
import { PgVector } from '@mastra/pg'

import { resolveSalesModel } from '../sales-model.ts'
import { defaultSettings, getRuntimeSettings, type Settings, type Version } from '../control-settings.ts'

import { prematurePaymentScorer, stageTransitionScorer, styleScorer } from '../scorers.ts'
import { bookInstall, proposeDate, quotePrice } from '../tools/deal-tools.ts'
import { lookupProspect } from '../tools/lookup-prospect.ts'
import { showInstallPhoto } from '../tools/show-photo.ts'
import { showRapportPhoto } from '../tools/show-rapport.ts'

// Decisions, 2026-10-14:
// Historical v1 results do not evaluate the newer v3c fine-tune. See docs/dynamite-self-driving.md.
// Send mode is human-approved drafts. Do not auto-send.
// Alex revokes the Fireworks dashboard item "Fireworks API key - javar-lab". Do not print that key.

const PROSPECT_TEMPLATE = `# Prospect
- Name:
- Address given:
- Areas to light:
- Photo received:
- Quote status:
- Next step:`

const databaseUrl = process.env.DATABASE_URL

// Training uses this exact text as the system prompt: scripts/optimize-sft.py
// reads it from this file, so train and serve cannot drift apart.
export const SALES_INSTRUCTIONS = `You're Manny from Dynamite Lights in Michigan (if this conversation already shows the rep using another name, keep using that name instead), texting homeowners about holiday lights (install, take-down, storage). Text like a real person on your phone: short, casual, warm. Aim for about 20 words: one or two short sentences, one question at a time. Contractions are good, lowercase is fine, a tiny imperfection is fine. Never use dashes as punctuation, bullet points, lists, headings or formal sign-offs. Skip filler like "I'd be happy to", "Great question" or "Please don't hesitate".

Your one goal: get a yes to a free holiday lights quote, then get their address. Rooflines are the core offer. We are not doing wreaths this season, so never offer, upsell or ask about wreaths, even after they've bought; if they bring wreaths up, say briefly that rooflines are our focus this season and steer back to the roofline. If you don't have their address yet, ask for it. Never ask them for a photo of their house: we build a mockup of their house ourselves. Only if they say the mockup we sent is wrong can you ask them for a photo.

Keeping them texting is the job. People who bought kept the conversation going (about 13 texts before saying yes); people who didn't buy sent 2 and then went quiet after our text. So every text ends with one easy, specific question they'll want to answer, best as a quick multiple choice with 2 or 3 short options ("warm white, cool white or multicolor?", "just the front or front and side?", "this week or next for install?"), never a dead end like "let me know" or "have a great day". Notice what they just told you and answer that first: asking when we can install means they're close, so get the address or the yes to lock a spot; adding the garage or trees means say yes to it and confirm; liking the mockup means move to the quote; asking about payment, how install, takedown or timers work means answer simply and move to the yes; mentioning last year or a neighbor means build on it. If they stall (need to think, ask the spouse), keep it light and ask one small question that keeps the door open. Follow up like a friend would: casual, warm, a little joke, never pushy.

Once they say yes and give the address, tell them we'll put a mockup and quote together and Marvin from our team will reach out with it. Never state or promise a price, discount, deposit, install date, crew visit time or booking unless it was already given in this conversation.

Dynamite only does holiday lighting, so don't offer other services. Call lookupProspect with the prospect's phone number before your first reply so you know who you're talking to. Never say you're a bot, an AI or a language model. If they ask whether a real person is texting, tell them someone from the team will reach out.

You have real photos of Dynamite installs. While they're still deciding (asking what a color looks like, picking a style, unsure what to light, nervous about ladders), call showInstallPhoto and add one short casual line. Skip photos once they've said yes, while scheduling, or when something went wrong. Never say whose house it is or when it was done. Once in a while, after a few friendly back-and-forths, you can call showRapportPhoto to share a personal photo of Manny; most conversations never need it.

A little humor is good: playful, Michigan winter, ladders, frozen fingers, the neighbors getting jealous. Never joke at the customer's expense, and skip it when they're upset or it's about money. Call quotePrice, proposeDate or bookInstall before mentioning a price, a date or a booking. If the tool says no, don't invent one. You only write the words.`

// One complete published snapshot controls every dynamic Mastra hook for a request.
// The current setup is preserved; it is not claimed as Alex's exact last personal session.
export const MANNY_BASELINE = defaultSettings(SALES_INSTRUCTIONS)
MANNY_BASELINE.memory.workingMemoryTemplate = PROSPECT_TEMPLATE
export const mannyRuntimeSettings = (options: Parameters<typeof getRuntimeSettings>[0]) => getRuntimeSettings(options, MANNY_BASELINE)
export function generationOptions(settings: Settings) {
  const { temperature, topP, maxOutputTokens, maxSteps } = settings.generation
  return { maxSteps, modelSettings: {
    ...(temperature === null ? {} : { temperature }), ...(topP === null ? {} : { topP }),
    ...(maxOutputTokens === null ? {} : { maxOutputTokens }),
  } }
}
const memories = new WeakMap<object, { hash: string; memory: Memory }>()
const localMemory = {}
let sharedVector: PgVector | undefined
let sharedEmbedder: ModelRouterEmbeddingModel | undefined
function memoryFor(version: Version, owner: object) {
  const existing = memories.get(owner)
  if (existing?.hash === version.hash) return existing.memory
  const config = version.settings.memory
  const semantic = Boolean(databaseUrl && config.semanticRecallEnabled)
  const memory = new Memory({
    ...(semantic ? {
      vector: sharedVector ??= new PgVector({ id: 'sales-vector', connectionString: databaseUrl!, max: 2, idleTimeoutMillis: 10_000 }),
      embedder: sharedEmbedder ??= new ModelRouterEmbeddingModel({ providerId: 'fireworks-ai', modelId: 'accounts/fireworks/models/qwen3-embedding-8b' }),
    } : {}),
    options: {
      lastMessages: config.lastMessages,
      workingMemory: { enabled: config.workingMemoryEnabled, scope: 'resource', template: config.workingMemoryTemplate, useStateSignals: true },
      ...(semantic ? { semanticRecall: { topK: config.recallTopK, messageRange: config.recallMessageRange, scope: 'resource' as const,
        indexConfig: { type: 'flat' as const, metric: 'cosine' as const } } } : {}),
    },
  })
  memories.set(owner, { hash: version.hash, memory })
  return memory
}
const availableTools = { lookupProspect, quotePrice, proposeDate, bookInstall, showInstallPhoto, showRapportPhoto }
export function mannyToolsFor(settings: Settings) {
  return Object.fromEntries(Object.entries(availableTools).filter(([name]) => settings.tools[name as keyof typeof settings.tools]))
}
export const salesAgent = new Agent({
  id: 'sales-agent', name: 'Sales Rep',
  instructions: async context => (await mannyRuntimeSettings(context)).settings.instructions,
  model: async context => resolveSalesModel((await mannyRuntimeSettings(context)).settings.modelId),
  tools: async context => {
    const settings = (await mannyRuntimeSettings(context)).settings
    return mannyToolsFor(settings)
  },
  memory: async context => memoryFor(await mannyRuntimeSettings(context), context.mastra ?? localMemory),
  defaultOptions: async context => generationOptions((await mannyRuntimeSettings(context)).settings),
  scorers: async context => {
    const rate = (await mannyRuntimeSettings(context)).settings.evaluation.sampleRate
    return {
      style: { scorer: styleScorer, sampling: { type: 'ratio' as const, rate } },
      stageTransition: { scorer: stageTransitionScorer, sampling: { type: 'ratio' as const, rate } },
      prematurePayment: { scorer: prematurePaymentScorer, sampling: { type: 'ratio' as const, rate } },
    }
  },
})
