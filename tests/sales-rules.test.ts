import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hasAddress, inferDealState } from '../src/mastra/deal-state.ts'
import { applySalesRules, asksForPhoto, offersWreath, quoteApprovedStop, pastQuote } from '../src/mastra/sales-rules.ts'

test('never offers wreaths this season', () => {
  assert.equal(offersWreath('want a lit wreath over the garage too?'), true)
  assert.equal(offersWreath("we're not doing wreaths this season, just rooflines"), false)
  const out = applySalesRules('sounds good', 'Want to add a wreath over the door?', false)
  assert.deepEqual(out.blocked, ['wreath'])
  assert.match(out.reply, /no wreaths/i)
  assert.match(out.reply, /address/i)
})

test('never asks the lead for a photo unless the mockup is wrong', () => {
  assert.equal(asksForPhoto('can you send a pic of the front of the house?'), true)
  assert.equal(asksForPhoto("here's one we just did"), false)
  assert.deepEqual(applySalesRules('yes please', 'Can you shoot me a photo of your house?', true).blocked, ['photo_request'])
  assert.deepEqual(applySalesRules('the mockup is wrong, that is not my house', 'Oh no, can you send a photo of the front?', true).blocked, [])
})

test('address alone qualifies; address + yes means quote requested', () => {
  assert.equal(inferDealState('', 'its 10 Oak Ave'), 'QUALIFIED')
  assert.equal(inferDealState('Customer: its 10 Oak Ave', 'yes go ahead'), 'CONFIRMED')
  assert.equal(inferDealState('', 'yes I want a quote'), 'NEW')
  assert.equal(hasAddress('', 'yes I want a quote'), false)
})

test('hard stop once a Jobber quote is approved, and when Jobber cannot be checked', () => {
  assert.equal(quoteApprovedStop({ jobberStatus: 'approved' }).stop, true)
  assert.equal(quoteApprovedStop({ jobberStatus: 'converted' }).stop, true)
  assert.equal(quoteApprovedStop({ jobberStatus: 'unknown' }).reason, 'jobber_status_unknown')
  assert.equal(quoteApprovedStop({ jobberStatus: 'sent', tags: ['approved lights 2026'] }).stop, true)
  assert.equal(quoteApprovedStop({ jobberStatus: 'sent', stageName: 'Approved Quote - Deposit Unverified' }).stop, true)
  assert.equal(quoteApprovedStop({ jobberStatus: 'sent', tags: ['quote requested'], stageName: 'Quote Sent' }).stop, false)
  assert.equal(quoteApprovedStop({ jobberStatus: 'none' }).stop, false)
})

test('wreath offers with unrelated negation are still caught', () => {
  assert.equal(offersWreath('no problem! want a wreath on the garage too?'), true)
  assert.equal(offersWreath('not a big deal, we can do a wreath'), true)
  assert.equal(offersWreath('no wreaths this year, just rooflines'), false)
  assert.equal(offersWreath("we're not doing wreaths this season"), false)
})

test('alternate photo-request wording is caught', () => {
  for (const ask of ['could you snap a quick shot of your place?', 'mind sending an image of the house?', 'can you take a pic of the roof for me?', 'need a picture of the front'])
    assert.equal(asksForPhoto(ask), true, ask)
  assert.equal(asksForPhoto('here is a shot of one we did'), false)
})

test('a yes without an address always gets the address ask', () => {
  const out = applySalesRules('yes I want a quote', 'awesome! our team will get started.', false)
  assert.deepEqual(out.blocked, ['address_missing'])
  assert.match(out.reply, /address/)
  assert.deepEqual(applySalesRules('yes', "awesome, what's the address?", false).blocked, [])
  assert.deepEqual(applySalesRules('yes', 'awesome! the team will get started.', true).blocked, [])
})

test('a wreath decline followed by an offer is still an offer', () => {
  assert.equal(offersWreath('no wreaths this year, but want a wreath over the garage?'), true)
})

test('jobber: malformed data or an unfamiliar status reads as unknown', async () => {
  const { jobberClient } = await import('../src/mastra/jobber.ts')
  const client = (data: unknown) => jobberClient(async () => data as Record<string, unknown>)
  assert.equal(await client({}).quoteStatusForPhone('+15550100'), 'unknown')
  assert.equal(await client({ clients: { nodes: [{ quotes: { nodes: [{ quoteStatus: 'mystery' }] } }] } }).quoteStatusForPhone('+15550100'), 'unknown')
  assert.equal(await client({ clients: { nodes: [{ quotes: { nodes: [{ quoteStatus: 'approved' }] } }] } }).quoteStatusForPhone('+15550100'), 'approved')
  assert.equal(await client({ clients: { nodes: [] } }).quoteStatusForPhone('+15550100'), 'none')
  assert.equal(await jobberClient(async () => { throw new Error('down') }).quoteStatusForPhone('+15550100'), 'unknown')
})

test('no address ask once the thread is past the quote', () => {
  assert.equal(pastQuote('customer: I already approved and put the deposit down'), true)
  assert.equal(pastQuote('customer: how much for the roofline?'), false)
})

test('pastQuote ignores questions, negations and rep lines; post-quote never restarts the pitch', () => {
  assert.equal(pastQuote('customer: Yes, do you require a deposit?'), false)
  assert.equal(pastQuote('customer: Yes, I have not paid a deposit'), false)
  assert.equal(pastQuote("rep: I've sent the invoice"), false)
  assert.equal(pastQuote('customer: I paid the deposit'), true)
  assert.equal(applySalesRules('I paid the deposit', 'Want to add a wreath over the door?', true, true).reply, "We're all about rooflines this year, no wreaths this season.")
  assert.doesNotMatch(applySalesRules('I paid the deposit', 'can you send a photo of the front?', true, true).reply, /quote|mockup/)
})

test('never asks about wreaths, even after the sale; a roofline-focus decline is fine', async () => {
  for (const t of ['which wreath size do you want?', 'did you still want the wreath on the door?', 'Do you have a hook for a wreath?']) assert.equal(offersWreath(t), true, t)
  assert.equal(offersWreath("no wreaths this season, rooflines are our focus. front only or front and side?"), false)
  assert.equal(applySalesRules('I paid the deposit', 'want the wreath over the garage too?', true, true).blocked[0], 'wreath')
  const { SALES_INSTRUCTIONS } = await import('../src/mastra/agents/sales-agent.ts').catch(() => ({ SALES_INSTRUCTIONS: '' }))
  void SALES_INSTRUCTIONS // Option A keeps the live prompt; the wreath rule is enforced in code above.
})

test('pastQuote judges sentences: conditionals do not count, a later question does not cancel a real payment (Codex r3)', () => {
  assert.equal(pastQuote('customer: Yes, if I paid a deposit today that would secure the booking'), false)
  assert.equal(pastQuote('customer: I paid the deposit. When can you install?'), true)
})

test('pastQuote: hypotheticals never count; a comma-joined question does not cancel a real payment (Codex ship r2)', () => {
  assert.equal(pastQuote('customer: Yes, suppose I paid a deposit today'), false)
  assert.equal(pastQuote('customer: I paid the deposit, when can you install?'), true)
  assert.equal(pastQuote('customer: Yes, if I paid a deposit today that would secure the booking'), false)
})
