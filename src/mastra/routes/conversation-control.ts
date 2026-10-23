import { timingSafeEqual } from 'node:crypto'
import { registerApiRoute } from '@mastra/core/server'
import { controlConversation, type ControlSql } from '../conversation-control.ts'

export const conversationControlRoute = registerApiRoute('/dynamite/conversations/control', {
  method: 'POST',
  requiresAuth: true,
  handler: async c => {
    const expected = process.env.MASTRA_API_TOKEN ?? ''
    const given = c.req.header('authorization')?.replace(/^Bearer /i, '') ?? ''
    const a = Buffer.from(expected), b = Buffer.from(given)
    const authenticated = Boolean(expected && given && a.length === b.length && timingSafeEqual(a, b))
    if (!authenticated) return c.json({ error: 'unauthorized' }, 401)
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'invalid JSON' }, 400) }
    const storage = c.get('mastra').getStorage() as unknown as { db?: ControlSql } | undefined
    const db = storage?.db
    try {
      const result = await controlConversation(authenticated, db && typeof db.none === 'function' && typeof db.oneOrNone === 'function' ? db : null, body)
      return c.json(result.body, result.status)
    } catch {
      return c.json({ error: 'conversation control unavailable' }, 503)
    }
  },
})
