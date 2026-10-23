// Pipeline push (Alex 2026-10-15): scan the GHL pipeline Alex names, draft the next text per open lead,
// and send NOTHING until Alex approves that exact batch. Contacting real customers is his gate, every batch.
//
//   draft:  node --env-file=.env --experimental-strip-types scripts/pipeline-push.ts draft <pipelineId> <batch_dir>
//   send:   node --env-file=.env --experimental-strip-types scripts/pipeline-push.ts send <batch.jsonl> --approved "<Alex's words, date>" --sha <sha256 prefix printed by draft>
//
// draft reads GHL (GHL_API_KEY = Dynamite sales private integration token, via 1Password at run time) and calls
// the model; it writes <batch_dir>/batch-<time>.jsonl (customer data: keep it out of git). send re-checks the
// hard stop (fail closed) per row, needs GHL_SEND_ENABLED=true, and writes a results file next to the batch.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Agent } from '@mastra/core/agent'
import { RequestContext } from '@mastra/core/request-context'

import { SALES_INSTRUCTIONS } from '../src/mastra/agents/sales-agent.ts'
import { hasAddress, inferDealState } from '../src/mastra/deal-state.ts'
import { ghlClient } from '../src/mastra/ghl.ts'
import { allOpportunities, approvalMatches, batchSha256, dedupeByContact } from '../src/mastra/pipeline.ts'
import { consentedMedia } from '../src/mastra/photos.ts'
import { sendDraftToGhl } from '../src/mastra/ghl-send.ts'
import { guardReply } from '../src/mastra/guard.ts'
import { graphqlFetcher, jobberClient } from '../src/mastra/jobber.ts'
import { applySalesRules, pastQuote, quoteApprovedStop } from '../src/mastra/sales-rules.ts'
import { threadLine } from '../src/mastra/text.ts'
import { bookInstall, proposeDate, quotePrice } from '../src/mastra/tools/deal-tools.ts'
import { lookupProspect } from '../src/mastra/tools/lookup-prospect.ts'
import { showInstallPhoto } from '../src/mastra/tools/show-photo.ts'

type Row = { contactId: string; phone: string; name: string; stageId: string; reply: string; blocked: string[]; skip?: string; dealState?: string }

async function draft(pipelineId: string, dir: string) {
  const ghl = ghlClient()
  if (!ghl) throw new Error('GHL_API_KEY is not set')
  const jobber = jobberClient(graphqlFetcher())
  const agent = new Agent({ id: 'sales-agent-push', name: 'Sales Rep (push)', instructions: SALES_INSTRUCTIONS, model: 'fireworks-ai/accounts/fireworks/models/qwen3p8-2p4t-a95b', tools: { lookupProspect, quotePrice, proposeDate, bookInstall, showInstallPhoto } })
  const rows: Row[] = []
  const opps = dedupeByContact(await allOpportunities(page => ghl.searchOpportunities(pipelineId, 100, page), 100))
  for (const opp of opps) {
    const contact = await ghl.getContact(opp.contactId)
    const base = { contactId: contact.id, phone: contact.phone, name: contact.name, stageId: opp.stageId, reply: '', blocked: [] as string[] }
    const stop = quoteApprovedStop({ jobberStatus: await jobber.quoteStatusForPhone(contact.phone), tags: contact.tags }, false)
    if (stop.stop) { rows.push({ ...base, skip: stop.reason }); continue }
    const thread = await ghl.getThread(contact.id)
    if (!thread.length) { rows.push({ ...base, skip: 'no_thread' }); continue }
    const lastUser = [...thread].reverse().find(m => m.role === 'user')?.text ?? ''
    const prior = thread.slice(0, -1).map(m => threadLine({ role: m.role, content: m.text })).filter(Boolean).join('\n')
    const dealState = inferDealState(prior, lastUser)
    const ctx = new RequestContext()
    ctx.set('dealState', dealState)
    ctx.set('photosSent', [])
    const result = await agent.generate(thread.map(m => ({ role: m.role, content: m.text })), { requestContext: ctx, maxSteps: 5 })
    const g = guardReply(lastUser, result.text ?? '', prior)
    const r = g.needsHuman ? { reply: g.reply, blocked: [] } : applySalesRules(lastUser, g.reply, hasAddress(prior, lastUser) || Boolean(contact.address) || pastQuote(`${prior}\n${lastUser}`), pastQuote(`${prior}\n${lastUser}`))
    rows.push({ ...base, dealState, reply: r.reply, blocked: [...g.blocked, ...r.blocked], ...(g.needsHuman ? { skip: 'needs_human' } : {}) })
  }
  const file = join(dir, `batch-${pipelineId}-${new Date().toISOString().replace(/[:.]/g, '')}.jsonl`)
  const text = rows.map(r => JSON.stringify(r)).join('\n') + '\n'
  writeFileSync(file, text)
  console.log(JSON.stringify({ batch: file, sha256: batchSha256(text), drafted: rows.filter(r => !r.skip).length, skipped: rows.filter(r => r.skip).length, sent: 0 }))
}

async function send(batch: string, approved: string, sha: string) {
  if (!approved.trim()) throw new Error('send needs --approved "<Alex\'s approval words and date>"')
  // Read once: the exact bytes that matched Alex's sha are the bytes that get sent.
  const text = readFileSync(batch, 'utf8')
  if (!approvalMatches(text, sha)) throw new Error('send needs --sha <first 12+ chars of the batch sha256 Alex approved>; the file changed or the sha is wrong')
  const jobber = jobberClient(graphqlFetcher())
  const rows = text.trim().split('\n').map(l => JSON.parse(l) as Row)
  const results = []
  for (const r of rows) {
    if (r.skip || !r.reply) { results.push({ contactId: r.contactId, sent: false, reason: r.skip ?? 'empty' }); continue }
    const stop = quoteApprovedStop({ jobberStatus: await jobber.quoteStatusForPhone(r.phone) }, true)
    if (stop.stop) { results.push({ contactId: r.contactId, sent: false, reason: stop.reason }); continue }
    results.push({ contactId: r.contactId, ...(await sendDraftToGhl({ contactId: r.contactId, reply: r.reply, mediaUrls: consentedMedia([], false) })) })
  }
  writeFileSync(batch.replace(/\.jsonl$/, '.results.json'), JSON.stringify({ approved, sha, at: new Date().toISOString(), results }, null, 2))
  console.log(JSON.stringify({ sent: results.filter(x => x.sent).length, notSent: results.filter(x => !x.sent).length }))
}

const [cmd, a, ...rest] = process.argv.slice(2)
const opt = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] ?? '' : '' }
if (cmd === 'draft') await draft(a, rest[0])
else if (cmd === 'send') await send(a, opt('--approved'), opt('--sha'))
else throw new Error('usage: draft <pipelineId> <batch_dir> | send <batch.jsonl> --approved "<words>" --sha <sha256 prefix>')
