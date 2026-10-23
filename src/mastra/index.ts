import { Mastra } from '@mastra/core'
import { SimpleAuth } from '@mastra/core/server'
import { VercelDeployer } from '@mastra/deployer-vercel'
import { Observability, MastraStorageExporter } from '@mastra/observability'
import { PostgresStore } from '@mastra/pg'
import { salesAgent } from './agents/sales-agent.ts'
import { ghlSmsRoute } from './routes/ghl-sms.ts'
import { conversationControlRoute } from './routes/conversation-control.ts'
import { salesJobsRoute } from './routes/sales-jobs.ts'
import { controlSettingsRoutes } from './routes/control-settings.ts'
import { controlPanelRoute } from './control-panel.ts'

// Each Vercel instance opens its own pools. Keep Neon pooled connections small;
// the @mastra/pg default (10-20) would exhaust capacity across many instances.
// 2, not 1: Mastra can run two queries at once inside one request.
const SERVERLESS_POOL = { max: 2, idleTimeoutMillis: 10_000 }

const storage = process.env.DATABASE_URL
  ? new PostgresStore({ id: 'mastra-storage', connectionString: process.env.DATABASE_URL, ...SERVERLESS_POOL })
  : undefined

// With MASTRA_API_TOKEN unset the token map is empty, so every request is rejected.
const apiToken = process.env.MASTRA_API_TOKEN
const tokens = apiToken ? { [apiToken]: { id: 'api', name: 'API client' } } : {}

export const mastra = new Mastra({
  agents: { salesAgent },
  ...(storage ? { storage } : {}),
  environment: process.env.VERCEL_ENV || 'development',
  // Every trace. Volume is one text at a time, and the filter redacts secrets by default.
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'sales-chatbot',
        exporters: [new MastraStorageExporter()],
      },
    },
  }),
  server: {
    auth: new SimpleAuth({ tokens }),
    apiRoutes: [ghlSmsRoute, conversationControlRoute, salesJobsRoute, ...controlSettingsRoutes, controlPanelRoute],
    // Built-in /api routes require auth, so this runs. The public SMS webhook flushes itself.
    middleware: [
      {
        path: '/api/*',
        handler: async (c, next) => {
          try {
            await next()
          } finally {
            await c.get('mastra').observability.flush()
          }
        },
      },
    ],
  },
  // Private chat aborts at 80 seconds; leave time for startup and the response.
  deployer: new VercelDeployer({ maxDuration: 120 }),
})
