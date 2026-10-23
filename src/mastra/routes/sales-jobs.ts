import { mannyRuntimeSettings } from '../agents/sales-agent.ts'
import { registerApiRoute } from '@mastra/core/server'
import { handleSalesJob } from '../sales-jobs.ts'
import type { WorkSql } from '../durable-work.ts'

export const salesJobsRoute = registerApiRoute('/dynamite/jobs', {
  method: 'POST', requiresAuth: true,
  handler: async c => {
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'invalid JSON' }, 400) }
    const storage = c.get('mastra').getStorage() as unknown as { db?: WorkSql } | undefined
    const db = storage?.db
    const version = db ? await mannyRuntimeSettings({ mastra: c.get('mastra'), requestContext: c.get('requestContext') }) : undefined
    const result = await handleSalesJob(true, db && typeof db.none === 'function' && typeof db.any === 'function' && typeof db.oneOrNone === 'function' ? db : null, body, version)
    return c.json(result.body, result.status)
  },
})
