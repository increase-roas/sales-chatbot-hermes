import type { Version } from './control-settings.ts'
import { resumePendingDraftCompletions } from './draft-completion.ts'
import { z } from 'zod'
import { ensureDurableWorkTables, type WorkSql } from './durable-work.ts'
import { customerContextFromEnv } from './customer-context-runtime.ts'
import { knowledgeTopicSchema } from './customer-context.ts'
import { prepareDueFollowupDrafts, registerSentQuote } from './followup-runtime.ts'
import { ghlClient } from './ghl.ts'
import { graphqlFetcher, jobberClient } from './jobber.ts'

const jobs = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('work.resume'), afterDraftId: z.uuid().optional() }).strict(),
  z.object({ action: z.literal('knowledge'), topic: knowledgeTopicSchema }).strict(),
  z.object({ action: z.literal('followups.run') }).strict(),
  z.object({ action: z.literal('followups.register'), contactId: z.string().min(1).max(128), quoteRef: z.string().min(1).max(256), quoteSentAt: z.iso.datetime() }).strict(),
])
export async function handleSalesJob(authenticated: boolean, db: WorkSql | null, body: unknown, version?: Version) {
  if (!authenticated) return { status: 401 as const, body: { error: 'unauthorized' } }
  const parsed = jobs.safeParse(body)
  if (!parsed.success) return { status: 400 as const, body: { error: 'invalid sales job' } }
  if (!db) return { status: 503 as const, body: { error: 'durable storage unavailable' } }
  try {
    const job = parsed.data
    await ensureDurableWorkTables(db)
    if (job.action === 'status') {
      const work = await db.any<{ kind: string; status: string; count: string }>(`SELECT kind,status,count(*)::text AS count FROM durable_sales_work GROUP BY kind,status ORDER BY kind,status`)
      return { status: 200 as const, body: { mode: 'draft', work, laya: 'unavailable: artifact and invocation not recovered', memoryEnabled: process.env.HINDSIGHT_ENABLED === 'true' } }
    }
    if (job.action === 'work.resume') {
      const results = await resumePendingDraftCompletions(db, { ghl: ghlClient(), jobber: jobberClient(graphqlFetcher()), ...(version ? { knowledge: customerContextFromEnv(process.env, undefined, version.settings.hindsight) } : {}) }, job.afterDraftId)
      return { status: 200 as const, body: { mode: 'draft', results, nextAfterDraftId: results.at(-1)?.draftId ?? null } }
    }
    if (job.action === 'knowledge') {
      const context = customerContextFromEnv(process.env, undefined, version?.settings.hindsight)
      if (!context) return { status: 503 as const, body: { error: 'company knowledge inactive' } }
      return { status: 200 as const, body: await context.start(job.topic) }
    }
    // These calls prepare drafts only. The authenticated operator supplies a verified Jobber receipt
    // until that provider's exact quote ID/sentAt schema is confirmed. No native sync is claimed.
    if (job.action === 'followups.register') {
      const rows = await registerSentQuote(db, { contactId: job.contactId, quoteRef: job.quoteRef, quoteSentAt: new Date(job.quoteSentAt) }, version)
      return { status: 200 as const, body: { scheduled: rows.map(r => ({ key: r.source_key, dueAt: r.due_at, status: r.status })), mode: 'draft' } }
    }
    const ghl = ghlClient()
    if (!ghl) return { status: 503 as const, body: { error: 'CRM connection unavailable' } }
    const results = await prepareDueFollowupDrafts(db, { ghl, jobber: jobberClient(graphqlFetcher()) }, new Date(), version?.settings)
    return { status: 200 as const, body: { mode: 'draft', results: results.map(r => ({ key: r.source_key, status: r.status, receipt: r.receipt })) } }
  } catch {
    return { status: 503 as const, body: { error: 'sales job dependency unavailable' } }
  }
}
