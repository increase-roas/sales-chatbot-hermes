import { getPinnedSettings } from '../control-settings.ts'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

import { pickPhoto, REVIEW_QUOTE } from '../photos.ts'

// The model asks for a photo; the route attaches it to the draft. Picks are recorded on the
// request context so the route can attach exactly one and skip photos already sent.
export const showInstallPhoto = createTool({
  id: 'show-install-photo',
  description:
    'Attach one photo of a real Dynamite install while they are still deciding: they ask what a color or style looks like, ' +
    'are unsure what to light, or worry about ladders. Skip it once they said yes, when scheduling, or when something went wrong. ' +
    'One per text at most. Say only what the photo shows; never say whose house it is or when it was done.',
  inputSchema: z.object({
    color: z.string().optional().describe('warm white, multicolor, red, red and green'),
    style: z.string().optional().describe('classic, modern, bold, fun, install, safety'),
    feature: z.string().optional().describe('roofline, bushes, wreaths, garage doors, uplights, door columns'),
    house: z.string().optional().describe("the prospect's kind of house, e.g. brick ranch, two story"),
  }),
  outputSchema: z.object({
    attached: z.boolean(),
    photoId: z.string(),
    shows: z.string(),
    reviewQuote: z.string(),
  }),
  execute: async (input, context) => {
    const ctx = context?.requestContext
    const photoSettings = (await getPinnedSettings(ctx))?.photos
    const sent = (ctx?.get('photosSent') as string[] | undefined) ?? []
    const picked = (ctx?.get('photoPicked') as string | undefined) ?? ''
    // Photos sell a look. Once the deal is confirmed or estimated, a photo only stalls it (eval 2026-10-15).
    const dealState = (ctx?.get('dealState') as string | undefined) ?? 'NEW'
    if (dealState === 'CONFIRMED' || dealState === 'ESTIMATE_SENT') {
      return { attached: false, photoId: '', shows: 'they already said yes; skip the photo and move them forward', reviewQuote: '' }
    }
    if (picked) return { attached: false, photoId: picked, shows: 'one photo is already attached to this text', reviewQuote: '' }
    const photo = pickPhoto(input, sent, ctx?.get('photoIncludePending') === true, photoSettings)
    if (!photo) return { attached: false, photoId: '', shows: 'no matching photo left; describe it in words', reviewQuote: '' }
    ctx?.set('photoPicked', photo.id)
    return {
      attached: true,
      photoId: photo.id,
      shows: photo.hook,
      reviewQuote: `${REVIEW_QUOTE.attribution} said: "${REVIEW_QUOTE.text}"`,
    }
  },
})
