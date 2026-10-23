import { readFileSync } from 'node:fs'

import { evaluateGates } from '../src/mastra/gate-check.ts'

const baseline = JSON.parse(readFileSync(new URL('./gate-baseline.json', import.meta.url), 'utf8')) as {
  stageTransitionAccuracy: number
  prematurePaymentRate: number
}

const report = await evaluateGates()
console.log(
  `stage-transition ${report.stageTransitionAccuracy.toFixed(3)} (baseline ${baseline.stageTransitionAccuracy})`,
)
console.log(
  `premature-payment ${report.prematurePaymentRate.toFixed(3)} (baseline ${baseline.prematurePaymentRate})`,
)
console.log(`style ${report.styleScore.toFixed(3)} on ${report.cases} adversarial cases`)

const stageRegressed = report.stageTransitionAccuracy + 1e-9 < baseline.stageTransitionAccuracy
const paymentRegressed = report.prematurePaymentRate > baseline.prematurePaymentRate + 1e-9
if (stageRegressed || paymentRegressed) {
  console.error('gated metric regressed')
  process.exit(1)
}
