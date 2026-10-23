import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSalesModel, DYNAMITE_FINE_TUNE } from '../src/mastra/sales-model.ts'

test('unconfigured sales model preserves existing working serverless model', () => {
  assert.equal(resolveSalesModel(''), 'fireworks-ai/accounts/fireworks/models/qwen3p8-2p4t-a95b')
})
test('explicit Fireworks deployment is used exactly without silently falling back', () => {
  assert.equal(resolveSalesModel('accounts/abloomster/models/dynamite-sales-qwen27b-v3c#accounts/abloomster/deployments/dynamite-v3c'),
    'fireworks-ai/accounts/abloomster/models/dynamite-sales-qwen27b-v3c#accounts/abloomster/deployments/dynamite-v3c')
  assert.equal(resolveSalesModel('fireworks-ai/accounts/abloomster/deployments/dynamite-v3c'),
    'fireworks-ai/accounts/abloomster/deployments/dynamite-v3c')
  assert.equal(DYNAMITE_FINE_TUNE, 'accounts/abloomster/models/dynamite-sales-qwen27b-v3c')
})
