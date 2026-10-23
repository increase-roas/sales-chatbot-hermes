import assert from 'node:assert/strict'
import { test } from 'node:test'

import { callContext, callHold, expandSameImage, jobberAcceptReply, personalFollowup, unsentOnly, verbalYes } from '../src/mastra/conversation-rules.ts'

test('verbal yes while a quote is out: only push Jobber acceptance', () => {
  assert.equal(verbalYes("yes let's do it"), true)
  assert.equal(verbalYes('maybe, still thinking'), false)
  assert.equal(verbalYes('no not yet'), false)
  assert.match(jobberAcceptReply('https://clienthub.getjobber.com/q/abc'), /approve.*https:\/\/clienthub/)
  assert.doesNotMatch(jobberAcceptReply('x'), /[–—]| - /)
  assert.match(jobberAcceptReply(''), /Marvin/)
})

test('calls: hold while live or just ended; pass transcripts and missed calls to the bot', () => {
  const now = new Date('2026-10-15T18:00:00Z')
  assert.deepEqual(callHold([{ id: '1', at: '2026-10-15T17:59:00Z', status: 'in-progress', direction: 'outbound' }], now), { hold: true, reason: 'call_in_progress' })
  assert.equal(callHold([{ id: '1', at: '2026-10-15T17:50:00Z', status: 'completed', direction: 'outbound' }], now).reason, 'call_just_ended')
  assert.equal(callHold([{ id: '1', at: '2026-10-15T16:00:00Z', status: 'completed', direction: 'outbound' }], now).hold, false)
  const ctx = callContext([
    { id: '1', at: '2026-10-15T16:00:00Z', status: 'completed', direction: 'outbound', durationSec: 240, transcript: 'they want roofline only, asked about warm white' },
    { id: '2', at: '2026-10-15T17:00:00Z', status: 'no-answer', direction: 'outbound' },
  ], now)
  assert.match(ctx, /roofline only/)
  assert.match(ctx, /missed/)
  assert.equal(callContext([{ id: '1', at: '2026-10-10T16:00:00Z', status: 'completed', direction: 'outbound' }], now), '')
})

test('3-hour personal follow-up: once, after 3h quiet, outside quiet hours, never after approval, unsent photo only', () => {
  const last = new Date('2026-10-15T14:00:00Z') // 10:00 Detroit
  const at = (h: number) => new Date(last.getTime() + h * 3600_000)
  const base = { lastMessageAt: last, approved: false, personalFollowupSent: false, photosSent: [] as string[], leadKey: 'k' }
  assert.equal(personalFollowup({ ...base, now: at(2) }).reason, 'not_quiet_3h')
  const ok = personalFollowup({ ...base, now: at(3.5) })
  assert.equal(ok.send, true)
  assert.equal(personalFollowup({ ...base, now: at(3.5), approved: true }).reason, 'quote_approved')
  assert.equal(personalFollowup({ ...base, now: at(3.5), personalFollowupSent: true }).reason, 'already_sent')
  assert.equal(personalFollowup({ ...base, now: new Date('2026-10-16T03:00:00Z') }).reason, 'quiet_hours') // 23:00 Detroit
  const all = ['rooftop-01', 'rooftop-07', 'rapport-colombia-12', 'rapport-channel4-13']
  assert.equal(personalFollowup({ ...base, now: at(3.5), photosSent: all }).reason, 'no_unsent_personal_photo')
})

test('never the same photo twice: 07 and 14 count as one image', () => {
  assert.ok(expandSameImage(['rooftop-07']).has('rooftop-high-14'))
  assert.ok(expandSameImage(['rooftop-high-14']).has('rooftop-07'))
  assert.deepEqual(unsentOnly(['rooftop-high-14', 'red-09'], ['rooftop-07']), ['red-09'])
})

test('ghl getCalls reads TYPE_CALL messages with status, duration and transcript; ignores SMS', async () => {
  const { ghlClient } = await import('../src/mastra/ghl.ts')
  const fake = (async (url: string) => {
    const u = String(url)
    const body = u.includes('/conversations/search')
      ? { conversations: [{ id: 'conv1' }] }
      : u.includes('/transcription')
        ? [{ transcript: 'wants roofline only' }]
        : { messages: { messages: [
            { id: 'm1', messageType: 'TYPE_CALL', direction: 'outbound', dateAdded: '2026-10-15T15:00:00Z', meta: { call: { status: 'completed', duration: 240 } } },
            { id: 'm2', messageType: 'TYPE_SMS', direction: 'inbound', body: 'hi', dateAdded: '2026-10-15T15:10:00Z' },
          ] } }
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  const calls = await ghlClient('k', 'https://x', fake)!.getCalls('c1')
  assert.deepEqual(calls, [{ id: 'm1', at: '2026-10-15T15:00:00Z', status: 'completed', direction: 'outbound', durationSec: 240, transcript: 'wants roofline only' }])
  assert.equal(callHold(calls, new Date('2026-10-15T15:10:00Z')).hold, true)
  assert.match(callContext(calls, new Date('2026-10-15T16:00:00Z')), /wants roofline only/)
})

test('negated approvals are not a verbal yes', () => {
  for (const t of ['I do not accept the quote', 'Do not approve it yet', "don't book it", 'wait, hold off']) assert.equal(verbalYes(t), false, t)
  for (const t of ['yes', "let's do it", 'sounds good, book it']) assert.equal(verbalYes(t), true, t)
})

test('refusals worded without "not" are not a verbal yes', () => {
  for (const t of ['I will never accept this quote', 'I refuse to approve this quote', 'we decline']) assert.equal(verbalYes(t), false, t)
})

test('verbal yes must be affirmative: questions and "cannot" are not a yes (Codex r3)', () => {
  for (const t of ['I cannot accept this quote', 'How do I accept this quote?', 'yes?']) assert.equal(verbalYes(t), false, t)
  for (const t of ['Yes!', 'ok yes book it', 'yeah we accept']) assert.equal(verbalYes(t), true, t)
})

test('"yes, but I cannot accept" is not a yes (Codex ship r2)', () => {
  assert.equal(verbalYes('Yes, but I cannot accept this quote'), false)
})
