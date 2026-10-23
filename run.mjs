import { mastra } from './src/mastra/index.ts'

const agent = mastra.getAgentById('sales-agent')
const response = await agent.generate(
  'Hi - I saw your ad about roof replacement, what area do you cover?'
)
console.log(response.text)