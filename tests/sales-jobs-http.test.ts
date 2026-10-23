import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Mastra } from '@mastra/core'
import { SimpleAuth } from '@mastra/core/server'
import { createHonoServer } from '@mastra/deployer/server'
import { salesJobsRoute } from '../src/mastra/routes/sales-jobs.ts'

test('registered jobs route rejects missing or invalid bearer and reaches handler with valid bearer', async () => {
  const mastra = new Mastra({ server: {
    auth: new SimpleAuth({ tokens: { 'offline-test-token': { id: 'test', name: 'Offline test' } } }),
    apiRoutes: [salesJobsRoute],
  } })
  const app = await createHonoServer(mastra, { tools: {}, isDev: false, browserStream: false })
  for (const [token, expected] of [['', 401], ['wrong', 401], ['offline-test-token', 503]] as const) {
    const response = await app.request('/dynamite/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ action: 'status' }),
    })
    assert.equal(response.status, expected)
    if (expected === 503) assert.equal((await response.json()).error, 'durable storage unavailable')
  }
})
