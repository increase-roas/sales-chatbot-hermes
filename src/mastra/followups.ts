import { detroitHour, QUIET_END, QUIET_START } from './conversation-rules.ts'
import { pickPhoto, type Photo, type PhotoSettings } from './photos.ts'

export type FollowupSettings = {
  enabled: boolean; spacingHours: number[]; minimumGapHours: number; lines: string[]
  quietStart: number; quietEnd: number; timeZone: string; personalAfterHours: number; callCooldownMinutes: number
}

// Friendly follow-ups after Marvin's quote went out and it isn't approved yet (Alex 2026-10-15):
// a real install photo plus a line like "we just did this one! can i add you to the route?".
// Never the same line twice to one person, never the same photo twice, max 4.
// Cadence (Alex approved 2026-10-15, $300k in 30 days): the 3-hour personal photo follow-up
// (conversation-rules.ts personalFollowup), then 24h, 48h, day 4, day 7; 9am to 9pm Detroit only.
// Grounded in real threads: buyers answer fast and revived deals answered a median 21h after their last text.
export const FOLLOWUP_LINES = [
  'we just finished this one! want me to add you to the route?',
  "just wrapped this roofline up, yours would look sick like this. should i save you a spot on the route?",
  "this one went up this week and the neighbors are already jealous lol. want me to pencil you in?",
  "here's one we did in the cold this morning, frozen fingers but worth it. ready to get on the route?",
  "routes are filling up fast this year. here's one we just did, want me to grab you a spot?",
  "no rush at all, just thought you'd like this one. any questions on the quote?",
  'quick one: this is the warm white glow people keep asking about. want me to hold a spot for you?',
  'just checking in! this one turned out great. anything holding you back on the quote?',
] as const

export const SPACING_HOURS = [24, 48, 96, 168] as const

export type FollowupState = {
  quoteSentAt: Date
  approved: boolean
  linesSent: string[]
  photosSent: string[]
  lastFollowupAt?: Date
  customerRepliedSince?: boolean
}

export type Followup = { line: string; photo: Photo | null; due: Date }

export function nextFollowup(state: FollowupState, now: Date, opts: { includePendingPhotos?: boolean; seed?: number; settings?: FollowupSettings; photos?: PhotoSettings } = {}): Followup | null {
  const settings = opts.settings
  if (settings?.enabled === false || state.approved || state.customerRepliedSince) return null
  const n = state.linesSent.length
  const spacing = settings?.spacingHours ?? SPACING_HOURS
  if (n >= spacing.length) return null
  const due = new Date(state.quoteSentAt.getTime() + spacing[n] * 3600_000)
  if (now < due) return null
  const hour = detroitHour(now, settings?.timeZone)
  const start = settings?.quietStart ?? QUIET_START, end = settings?.quietEnd ?? QUIET_END
  if (start > end ? hour >= start || hour < end : start < end && hour >= start && hour < end) return null
  if (state.lastFollowupAt && now.getTime() - state.lastFollowupAt.getTime() < (settings?.minimumGapHours ?? 20) * 3600_000) return null
  const unused = (settings?.lines ?? FOLLOWUP_LINES).filter(l => !state.linesSent.includes(l))
  if (!unused.length) return null
  const line = unused[((opts.seed ?? 0) + n) % unused.length]
  const photo = pickPhoto({}, state.photosSent, opts.includePendingPhotos ?? false, opts.photos)
  return { line, photo, due }
}
