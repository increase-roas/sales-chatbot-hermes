import { getPinnedSettings } from '../control-settings.ts'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

import { pickRapport, rapportAllowed } from '../photos.ts'

// Manny's personal photos (Colombia with his wife, his old company on Channel 4), for rapport.
// Code enforces: never the first reply, only after some back-and-forth, at most once per conversation,
// sparingly, and it shares the one-photo-per-text slot with install photos.
export const showRapportPhoto = createTool({
  id: 'show-rapport-photo',
  description:
    'Rarely, when the chat is friendly and has gone back and forth a few times, attach one personal photo of Manny ' +
    '(e.g. him in Colombia with his wife, or his old company on the news). Write a short casual line in your own words ' +
    'from the seed; never paste the seed word for word. Most conversations should never use this.',
  inputSchema: z.object({ reason: z.string().optional().describe('why a personal moment fits right now') }),
  outputSchema: z.object({ attached: z.boolean(), photoId: z.string(), seed: z.string(), note: z.string() }),
  execute: async (_input, context) => {
    const ctx = context?.requestContext
    const photoSettings = (await getPinnedSettings(ctx))?.photos
    if (ctx?.get('photoPicked')) return { attached: false, photoId: '', seed: '', note: 'a photo is already attached to this text' }
    const sent = (ctx?.get('photosSent') as string[] | undefined) ?? []
    const allowed = rapportAllowed({
      customerTurns: Number(ctx?.get('customerTurns') ?? 0),
      rapportAlreadySent: sent.some(id => id.startsWith('rapport-')),
      leadKey: String(ctx?.get('leadKey') ?? ''),
    })
    if (!allowed) return { attached: false, photoId: '', seed: '', note: 'not now: keep it about their lights' }
    const photo = pickRapport(String(ctx?.get('leadKey') ?? ''), sent, photoSettings)
    if (!photo) return { attached: false, photoId: '', seed: '', note: 'no personal photo left' }
    ctx?.set('photoPicked', photo.id)
    const speaker = String(ctx?.get('speakerName') ?? 'Manny')
    const note = speaker === 'Manny' ? 'you are Manny, so it is your photo' : `you are ${speaker}; this is Manny, the owner, so say "manny" not "me"`
    return { attached: true, photoId: photo.id, seed: photo.seed, note }
  },
})
