import library from './photo-library.ts'

// Real Dynamite installs Alex supplied (src/mastra/photo-library.ts). The bot attaches at most
// one per reply, never repeats one inside a conversation, and never sends a customer's own house.
export type Photo = {
  id: string
  file: string
  colors: string[]
  styles: string[]
  house: string
  features: string[]
  consent: string
  kind: string
  hook: string
  sameImageAs?: string
  captions?: { manny: string[]; other: string[] }
  url?: string
}

export type PhotoQuery = {
  color?: string
  style?: string
  feature?: string
  house?: string
}

export const PHOTOS: Photo[] = library.photos as Photo[]
export type RapportPhoto = (typeof library.rapport)[number]
export const RAPPORT: RapportPhoto[] = library.rapport
export const REVIEW_QUOTE = library.review_quote

export type PhotoSettings = {
  installEnabled: boolean
  rapportEnabled: boolean
  disabledIds: string[]
  overrides: Array<{ id: string; caption: string | null }>
}

function configuredPhoto<T extends { id: string; url?: string }>(photo: T, settings?: PhotoSettings): T {
  const override = settings?.overrides.find(item => item.id === photo.id)
  if (!override) return photo
  return { ...photo,
    ...(override.caption !== null ? ('hook' in photo ? { hook: override.caption } : { seed: override.caption }) : {}) }
}

export function photosForSettings(settings?: PhotoSettings) {
  return [...PHOTOS, ...RAPPORT].filter(photo => !settings?.disabledIds.includes(photo.id) &&
    (photo.id.startsWith('rapport-') ? settings?.rapportEnabled !== false : settings?.installEnabled !== false))
    .map(photo => configuredPhoto(photo, settings))
}

function norm(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()
}

function score(photo: Photo, query: PhotoQuery): number {
  let points = 0
  const color = norm(query.color)
  if (color) {
    if (photo.colors.some(c => color.includes(c) || c.includes(color))) points += 4
    else if (color.includes('white') && photo.colors.includes('warm white')) points += 3
    else if ((color.includes('multi') || color.includes('rainbow')) && photo.colors.includes('multicolor')) points += 4
    else points -= 2
  }
  const style = norm(query.style)
  if (style && photo.styles.some(s => style.includes(s))) points += 3
  const feature = norm(query.feature)
  if (feature && photo.features.some(f => feature.includes(f) || f.includes(feature))) points += 2
  const house = norm(query.house)
  if (house && house.split(' ').some(word => word.length > 3 && photo.house.includes(word))) points += 1
  return points
}

// Picks the best unsent photo for the query. Returns null when nothing fits or all were sent.
// Only photos whose homeowner consent is granted can be sent. includePending exists for offline
// evals and Alex's private review page; the live route never passes it.
export function pickPhoto(query: PhotoQuery, alreadySent: string[] = [], includePending = false, settings?: PhotoSettings): Photo | null {
  if (settings?.installEnabled === false) return null
  // Two files of the same scene count as one image, so a lead never gets the same view twice.
  const sent = new Set(alreadySent.flatMap(id => [id, ...PHOTOS.filter(p => p.sameImageAs === id || p.id === PHOTOS.find(x => x.id === id)?.sameImageAs).map(p => p.id)]))
  const ranked = PHOTOS.filter(p => !sent.has(p.id) && !settings?.disabledIds.includes(p.id) && (p.consent === 'granted' || includePending))
    .map((p, i) => ({ p, s: score(p, query), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
  const best = ranked[0]
  if (!best) return null
  const asked = Boolean(query.color || query.style || query.feature || query.house)
  if (asked && best.s <= 0) return null
  return configuredPhoto(best.p, settings)
}

// Public URL for a photo: its own hosted `url` in photo-library.ts (set after uploading to the GHL
// media library, one URL per file), else PHOTO_BASE_URL + file. Without either nothing is attached.
export function photoUrl(photo: { file: string; url?: string }, base = process.env.PHOTO_BASE_URL ?? ''): string | null {
  const hosted = photo.url
  if (hosted) return hosted
  if (!base) return null
  return `${base.replace(/\/+$/, '')}/${photo.file}`
}

// GHL "Send a new message" body (POST /conversations/messages, type SMS, attachments = URL array).
// Built here so the approved-draft sender has one tested shape; nothing in this repo calls GHL yet.
export function ghlSmsPayload(contactId: string, message: string, mediaUrls: string[]): {
  type: 'SMS'
  contactId: string
  message: string
  attachments?: string[]
} {
  const attachments = limitMedia(mediaUrls)
  return { type: 'SMS', contactId, message, ...(attachments.length ? { attachments } : {}) }
}

// At most one attachment per reply.
export function limitMedia(urls: string[]): string[] {
  return urls.filter(Boolean).slice(0, 1)
}

// Send boundary: a customer only ever receives photos whose homeowner consent is granted.
// Alex's own test number may receive pending ones (his uploads). Unknown URLs are dropped.
export function consentedMedia(urls: string[], toTestNumber: boolean, library: Array<{ file: string; consent: string; url?: string }> = [...PHOTOS, ...RAPPORT]): string[] {
  return limitMedia(
    urls.filter(url => {
      const photo = library.find(p => url === p.url || url.endsWith(`/${p.file}`))
      return Boolean(photo) && (toTestNumber || photo!.consent === 'granted')
    }),
  )
}

// Rapport photos (Manny's life): at most once per conversation, never in the first reply, only after
// some back-and-forth, and sparingly (about one conversation in three qualifies, stable per lead).
export function rapportAllowed(input: { customerTurns: number; rapportAlreadySent: boolean; leadKey: string }): boolean {
  if (input.rapportAlreadySent || input.customerTurns < 3) return false
  let h = 0
  for (const ch of input.leadKey) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % 3 === 0
}

export function pickRapport(leadKey: string, alreadySent: string[], settings?: PhotoSettings): RapportPhoto | null {
  if (settings?.rapportEnabled === false) return null
  const left = RAPPORT.filter(r => !alreadySent.includes(r.id) && !settings?.disabledIds.includes(r.id))
  if (!left.length) return null
  let h = 7
  for (const ch of leadKey) h = (h * 33 + ch.charCodeAt(0)) >>> 0
  return configuredPhoto(left[h % left.length], settings)
}

// The bot speaks as Manny unless the thread already uses another name for the rep.
export function speakerName(priorRepText: string): string {
  const m = priorRepText.match(/\b(?:this is|it'?s|i'?m)\s+([A-Z][a-z]{2,12})\b/)
  return m && !/^(Dynamite|Just|Here|Really|So)$/.test(m[1]) ? m[1] : 'Manny'
}
