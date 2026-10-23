// Bounded model comparison: existing Manny prompt/tools on synthetic rows; no customer send.
// Reuses src/mastra/routes/ghl-sms.ts instructions and six tools (including the photo
// tool), deal state from inferDealState, rep examples from the rep_examples table, then guardReply.
// Differences: the thread comes from the holdout row instead of Mastra memory, nothing is saved,
// and rep examples whose reply matches this row's real rep reply are dropped (no answer leak).
// Reads: rep_examples (SELECT only, plain pg, so no Mastra table setup runs). Writes: one local JSONL.
//
// Usage: node --env-file=.env --experimental-strip-types scripts/eval-agent.ts <rows.jsonl> <out.jsonl> [limit]

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import { Agent } from '@mastra/core/agent'
import { RequestContext } from '@mastra/core/request-context'
import pg from 'pg'

import { resolveSalesModel } from '../src/mastra/sales-model.ts'
import { SALES_INSTRUCTIONS } from '../src/mastra/agents/sales-agent.ts'
import { hasAddress, inferDealState } from '../src/mastra/deal-state.ts'
import { applySalesRules, pastQuote } from '../src/mastra/sales-rules.ts'
import { guardReply } from '../src/mastra/guard.ts'
import { examplesBlock, similarRepExamples, type RepExample } from '../src/mastra/rep-examples.ts'
import { threadLine } from '../src/mastra/text.ts'
import { bookInstall, proposeDate, quotePrice } from '../src/mastra/tools/deal-tools.ts'
import { lookupProspect } from '../src/mastra/tools/lookup-prospect.ts'
import { showInstallPhoto } from '../src/mastra/tools/show-photo.ts'
import { showRapportPhoto } from '../src/mastra/tools/show-rapport.ts'
import { speakerName } from '../src/mastra/photos.ts'
import { requireSpend } from './fw-guard.ts'

requireSpend() // config/spend.json: daily cap + low-balance hold

const MODEL = resolveSalesModel()
// Optional variant for A/B rating rounds, appended after the instructions (EVAL_EXTRA env).
const EXTRA = process.env.EVAL_EXTRA ?? ''
const [rowsPath, outPath, limitArg] = process.argv.slice(2)
type Msg = { role: string; content: string }
const rows = readFileSync(rowsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { messages: Msg[] })
const limit = limitArg ? Number(limitArg) : rows.length

// GHL lookup env is deliberately absent here, so lookupProspect returns its empty result (no CRM reads).
delete process.env.GHL_API_KEY
const agent = new Agent({
  id: 'sales-agent-eval',
  name: 'Sales Rep (eval)',
  instructions: SALES_INSTRUCTIONS,
  model: MODEL,
  tools: { lookupProspect, quotePrice, proposeDate, bookInstall, showInstallPhoto, showRapportPhoto },
})

const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 }) : null
const db = {
  none: async () => { throw new Error('read-only eval') },
  any: async <T,>(q: string, v?: unknown[]) => {
    if (!/^\s*SELECT/i.test(q)) throw new Error('read-only eval')
    return ((await pool!.query(q, v as unknown[])).rows as T[])
  },
}

function words(t: string): Set<string> {
  return new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean))
}
function similar(a: string, b: string): boolean {
  const x = words(a), y = words(b)
  const inter = [...x].filter(w => y.has(w)).length
  return inter / Math.max(1, new Set([...x, ...y]).size) >= 0.6
}

async function one(i: number) {
  requireSpend(10 * 60_000) // re-checks the cap and balance every 10 min during long runs
  const msgs = rows[i].messages.filter(m => m.role !== 'system')
  const target = msgs[msgs.length - 1].content
  const context = msgs.slice(0, -1)
  const message = [...context].reverse().find(m => m.role === 'user')?.content ?? ''
  const prior = context.slice(0, -1).map(threadLine).filter(Boolean).join('\n')
  const dealState = inferDealState(prior, message)
  const requestContext = new RequestContext()
  requestContext.set('dealState', dealState)
  requestContext.set('photosSent', [])
  // Offline eval only: photos are still consent-pending, so let the picker see them.
  requestContext.set('photoIncludePending', true)
  requestContext.set('customerTurns', context.filter(m => m.role === 'user').length)
  requestContext.set('leadKey', `row-${i}`)
  requestContext.set('speakerName', speakerName(context.filter(m => m.role === 'assistant').map(m => m.content).join('\n')))
  let examples: RepExample[] = []
  let leaksDropped = 0
  if (pool) {
    const found = await similarRepExamples(db, message, 8)
    examples = found.filter(ex => !similar(ex.rep_text, target)).slice(0, 5)
    leaksDropped = found.slice(0, 5).filter(ex => similar(ex.rep_text, target)).length
  }
  const block = examplesBlock(examples)
  const started = Date.now()
  const result = await agent.generate(context.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })), {
    requestContext,
    maxSteps: 5,
    modelSettings: { temperature: 0.3, maxOutputTokens: 384 },
    instructions: [SALES_INSTRUCTIONS, `Your name in this conversation: ${requestContext.get('speakerName')}.`, block, EXTRA].filter(Boolean).join('\n\n'),
  })
  const raw = result.text ?? ''
  const base = guardReply(message, raw, prior)
  const ruled = base.needsHuman ? { reply: base.reply, blocked: [] as string[] } : applySalesRules(message, base.reply, hasAddress(prior, message) || pastQuote(`${prior}\n${message}`), pastQuote(`${prior}\n${message}`))
  const guarded = { ...base, reply: ruled.reply, blocked: [...base.blocked, ...ruled.blocked] }
  const toolNames = (result.steps ?? []).flatMap(s => (s.toolCalls ?? []).map(c => (c as { payload?: { toolName?: string }; toolName?: string }).payload?.toolName ?? (c as { toolName?: string }).toolName ?? ''))
  return {
    i, label: 'agent-final', model: MODEL, dealState, raw, reply: guarded.reply, blocked: guarded.blocked,
    needsHuman: guarded.needsHuman, photoId: guarded.blocked.some(b => b !== 'dash') ? '' : ((requestContext.get('photoPicked') as string | undefined) ?? ''),
    tools: toolNames.filter(Boolean), examples: examples.length, leaksDropped,
    instructionsSha256: createHash('sha256').update([SALES_INSTRUCTIONS, `Your name in this conversation: ${requestContext.get('speakerName')}.`, block, EXTRA].filter(Boolean).join('\n\n')).digest('hex'),
    examplesBlock: block,
    settings: { temperature: 0.3, maxOutputTokens: 384, maxSteps: 5, reasoning: 'provider default; not explicitly configured' },
    usage: result.usage ?? result.totalUsage ?? null, ms: Date.now() - started,
  }
}

const out: unknown[] = []
const queue = Array.from({ length: Math.min(limit, rows.length) }, (_, i) => i)
async function worker() {
  for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
    try {
      out.push(await one(i))
    } catch (error) {
      out.push({ i, label: 'agent-final', reply: '', error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' })
    }
  }
}
await Promise.all(Array.from({ length: 6 }, worker))
out.sort((a, b) => (a as { i: number }).i - (b as { i: number }).i)
writeFileSync(outPath, out.map(o => JSON.stringify(o)).join('\n') + '\n')
await pool?.end()
const ok = out.filter(o => (o as { reply?: string }).reply)
console.log(JSON.stringify({ rows: out.length, withReply: ok.length, errors: out.length - ok.length, photos: out.filter(o => (o as { photoId?: string }).photoId).length }))
