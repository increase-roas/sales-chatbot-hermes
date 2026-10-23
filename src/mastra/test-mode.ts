// Alex texts the bot from a test number and rates each reply right in the thread (Alex 2026-10-15).
// Test numbers come from BOT_TEST_PHONES (comma separated). Ratings land in sms_grades, which
// scripts/export-grades.ts already turns into SFT (approve) and DPO (edit/reject) data.
import type { Grade } from './drafts.ts'

export function isTestPhone(phone: string, env: Record<string, string | undefined> = process.env): boolean {
  const digits = (value: string) => value.replace(/\D/g, '').slice(-10)
  const list = (env.BOT_TEST_PHONES ?? '').split(',').map(digits).filter(d => d.length === 10)
  return Boolean(phone) && list.includes(digits(phone))
}

// 👍 / "good" = approve; 👎 / "bad" = reject; "rate: <better text>" = edit with the text you'd send instead.
export function parseRating(message: string): { grade: Grade; editedReply?: string } | null {
  const text = message.trim()
  const rate = text.match(/^rate\s*:\s*([\s\S]+)$/i)
  if (rate) return { grade: 'edit', editedReply: rate[1].trim() }
  if (/^(👍|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿|good|yes good|\+1)$/i.test(text)) return { grade: 'approve' }
  if (/^(👎|👎🏻|👎🏼|👎🏽|👎🏾|👎🏿|bad|-1)$/i.test(text)) return { grade: 'reject' }
  return null
}

export const RATING_ACK: Record<Grade, string> = {
  approve: 'saved 👍',
  reject: 'saved 👎 (tip: "rate: <what you would text>" teaches it the better reply)',
  edit: 'saved your better text',
}

// Test-mode send is allowed only when the payload phone is a listed test number AND the GHL contact we
// would text has that same phone (so a spoofed or mismatched contact id can never reach a customer).
export function testDestinationOk(payloadPhone: string, contactPhone: string, env: Record<string, string | undefined> = process.env): boolean {
  const digits = (value: string) => value.replace(/\D/g, '').slice(-10)
  return isTestPhone(payloadPhone, env) && digits(payloadPhone).length === 10 && digits(payloadPhone) === digits(contactPhone)
}
