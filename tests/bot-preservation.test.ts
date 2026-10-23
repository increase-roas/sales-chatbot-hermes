import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RequestContext } from '@mastra/core/request-context'
import { salesAgent, SALES_INSTRUCTIONS } from '../src/mastra/agents/sales-agent.ts'

test('Manny keeps his voice and both photo tools through native dynamic configuration', async () => {
  const requestContext = new RequestContext()
  const instructions = await salesAgent.getInstructions({ requestContext })
  assert.equal(instructions, SALES_INSTRUCTIONS)
  assert.match(String(instructions), /You're Manny from Dynamite Lights/)
  assert.match(String(instructions), /Never ask them for a photo of their house/)
  const tools = await salesAgent.listTools({ requestContext })
  assert.ok(tools.showInstallPhoto)
  assert.ok(tools.showRapportPhoto)
})
