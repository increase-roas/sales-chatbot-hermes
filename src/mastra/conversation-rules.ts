// Alex 2026-10-15 (second batch): verbal yes -> Jobber acceptance only; call awareness; 3-hour personal
// follow-up; never the same photo twice. Pure functions here; the route and runners wire them in.
import { PHOTOS, RAPPORT } from './photos.ts'

// 1. Verbal yes while a Jobber quote is out: the only next move is getting it accepted in Jobber.
const VERBAL_YES = /\b(yes|yep|yeah|let'?s do it|lets do it|go ahead|sounds good|we'?ll take it|book (?:it|us|me)|i'?m in|deal|approve|accept)\b/i
const NOT_YES = /\b(not yet|no|nope|maybe|thinking|later|not sure|too (?:much|expensive)|not|don'?t|do not|won'?t|can'?t|cannot|but|however|hold off|wait|never|refuse|reject|decline|cancel|pass)\b|n't\b/i

// Affirmative only: the text must OPEN with the yes, carry no question and no refusal word (Codex r3:
// "how do I accept this quote?" and "I cannot accept" are not a yes).
const LEADING_YES = /^\W*(?:ok(?:ay)?[ ,]+)?(?:yes|yep|yeah|yup|sure|let'?s do it|lets do it|go ahead|sounds good|we'?ll take it|book (?:it|us|me)|i'?m in|deal|approved?|i accept|we accept)\b/i

export function verbalYes(message: string): boolean {
  const text = message.trim()
  return LEADING_YES.test(text) && VERBAL_YES.test(text) && !text.includes('?') && !NOT_YES.test(text)
}

export function jobberAcceptReply(link: string): string {
  return link
    ? `awesome!! just tap approve on the quote here so we can lock you in: ${link}`
    : "awesome!! Marvin is texting you the quote link now, just tap approve on it and you're locked in"
}

// 2. Calls: hold while a call is live or just happened; otherwise pass what was said to the bot.
export type CallRecord = { id: string; at: string; status: string; direction: string; durationSec?: number; transcript?: string; notes?: string }
export const CALL_COOLDOWN_MIN = 20

export function callHold(calls: CallRecord[], now: Date, cooldownMinutes = CALL_COOLDOWN_MIN): { hold: boolean; reason: string } {
  for (const c of calls) {
    const status = c.status.toLowerCase()
    if (/in[- ]?progress|ringing|queued|initiated|active/.test(status)) return { hold: true, reason: 'call_in_progress' }
    const minutes = (now.getTime() - new Date(c.at).getTime()) / 60_000
    if (minutes >= 0 && minutes < cooldownMinutes && /completed|answered|ended/.test(status)) return { hold: true, reason: 'call_just_ended' }
  }
  return { hold: false, reason: '' }
}

// Text for the bot's instructions: recent calls (24h) with transcript or notes, so it never repeats or
// contradicts what was said on the phone. Missed calls are mentioned so the bot can acknowledge them.
export function callContext(calls: CallRecord[], now: Date): string {
  const recent = calls.filter(c => now.getTime() - new Date(c.at).getTime() < 24 * 3600_000)
  if (!recent.length) return ''
  const lines = recent.map(c => {
    const what = /no[- ]?answer|missed|busy|failed|voicemail/i.test(c.status) ? `a ${c.direction} call was missed` : `a ${c.direction} call happened (${Math.round((c.durationSec ?? 0) / 60)} min)`
    const said = (c.transcript || c.notes || '').trim()
    return `- ${c.at}: ${what}${said ? `. What was said: ${said.slice(0, 1200)}` : ''}`
  })
  return [
    'Recent phone calls with this lead (use them: never repeat or contradict what was said on the phone; if a call was missed, mention it casually):',
    ...lines,
  ].join('\n')
}

// 3. One personal follow-up 3 hours after the conversation goes quiet, outside quiet hours, never after approval.
export const PERSONAL_PHOTO_IDS = ['rooftop-01', 'rooftop-07', 'rooftop-high-14', ...RAPPORT.map(r => r.id)]
export const QUIET_START = 21
export const QUIET_END = 9

export function detroitHour(date: Date, timeZone = 'America/Detroit'): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).format(date)) % 24
}

export function personalFollowup(
  input: { lastMessageAt: Date; now: Date; approved: boolean; personalFollowupSent: boolean; photosSent: string[]; leadKey: string },
  settings?: { enabled: boolean; personalAfterHours: number; quietStart: number; quietEnd: number; timeZone: string },
): { send: boolean; reason: string; photoId?: string } {
  if (settings?.enabled === false) return { send: false, reason: 'followups_paused' }
  if (input.approved) return { send: false, reason: 'quote_approved' }
  if (input.personalFollowupSent) return { send: false, reason: 'already_sent' }
  if (input.now.getTime() - input.lastMessageAt.getTime() < (settings?.personalAfterHours ?? 3) * 3600_000) return { send: false, reason: 'not_quiet_3h' }
  const hour = detroitHour(input.now, settings?.timeZone)
  const start = settings?.quietStart ?? QUIET_START, end = settings?.quietEnd ?? QUIET_END
  if (start > end ? hour >= start || hour < end : start < end && hour >= start && hour < end) return { send: false, reason: 'quiet_hours' }
  const sent = expandSameImage(input.photosSent)
  const left = PERSONAL_PHOTO_IDS.filter(id => !sent.has(id))
  if (!left.length) return { send: false, reason: 'no_unsent_personal_photo' }
  let h = 5
  for (const ch of input.leadKey) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return { send: true, reason: '', photoId: left[h % left.length] }
}

// 4. Never the same photo twice to one contact: 07 and 14 are the same image, so either blocks both.
export function expandSameImage(ids: string[]): Set<string> {
  const out = new Set(ids)
  for (const p of PHOTOS) {
    if (p.sameImageAs && (out.has(p.id) || out.has(p.sameImageAs))) {
      out.add(p.id)
      out.add(p.sameImageAs)
    }
  }
  return out
}

export function unsentOnly(photoIds: string[], alreadySent: string[]): string[] {
  const sent = expandSameImage(alreadySent)
  return photoIds.filter(id => !sent.has(id))
}
