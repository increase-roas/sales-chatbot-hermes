import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { registerApiRoute } from '@mastra/core/server'
import { z } from 'zod'
import { DYNAMITE_COMPANY_ID } from '../customer-context.ts'
import { PHOTOS, RAPPORT } from '../photos.ts'
import { bundledPhotos } from '../photo-assets.ts'
import { MANNY_BASELINE } from '../agents/sales-agent.ts'
import { photoCards, PgSettingsStore, readySettingsDb, settingsSchema } from '../control-settings.ts'
import { runMannyTest, testChatSchema, testChatAvailability } from '../control-chat.ts'

const saveSchema = z.object({ label: z.string().trim().min(1).max(160), settings: settingsSchema }).strict()
const activateSchema = z.object({ versionId: z.string().min(1).max(200), expectedActiveId: z.string().min(1).max(200) }).strict()
const restoreSchema = z.object({ versionId: z.string().min(1).max(200), label: z.string().trim().min(1).max(160).optional() }).strict()
type Action = 'state' | 'save' | 'activate' | 'restore' | 'photo' | 'chat'
function route(path: string, action: Action) {
  return registerApiRoute(path, {
    method: action === 'state' || action === 'photo' ? 'GET' : 'POST',
    requiresAuth: true,
    handler: async c => {
      c.header('Cache-Control', 'no-store')
      const expected = process.env.MASTRA_API_TOKEN ?? ''
      const given = c.req.header('authorization')?.replace(/^Bearer /i, '') ?? ''
      const a = Buffer.from(expected), b = Buffer.from(given)
      if (!expected || !given || a.length !== b.length || !timingSafeEqual(a, b)) return c.json({ error: 'unauthorized' }, 401)
      if (action === 'photo') {
        const photo = [...PHOTOS, ...RAPPORT].find(p => p.id === c.req.param('photoId'))
        if (!photo || basename(photo.file) !== photo.file || !/\.jpe?g$/i.test(photo.file)) return c.json({ error: 'Photo not found' }, 404)
        const directory = process.env.MANNY_PHOTO_DIR
        try {
          const encoded = bundledPhotos[photo.file]
          const bytes = directory ? await readFile(join(directory, photo.file)) : encoded ? Buffer.from(encoded, 'base64') : undefined
          if (!bytes) return c.json({ error: 'Photo not found' }, 404)
          return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } })
        } catch { return c.json({ error: 'Photo not found' }, 404) }
      }
      if (action === 'chat') {
        let payload: unknown
        try { payload = await c.req.json() } catch { return c.json({ error: 'Enter a message and select a saved version.' }, 400) }
        const parsed = testChatSchema.safeParse(payload)
        if (!parsed.success) return c.json({ error: 'Invalid chat request', fieldErrors: parsed.error.flatten().fieldErrors }, 400)
        const ready = testChatAvailability()
        if (!ready.enabled) return c.json({ error: ready.reason, code: ready.configured ? 'chat_not_enabled' : 'provider_not_configured' }, 503)
        let version
        try {
          const db = await readySettingsDb(c.get('mastra'))
          if (!db) return c.json({ error: 'Version storage is unavailable; no model call was made.', code: 'storage_unavailable' }, 503)
          version = (await new PgSettingsStore(db, MANNY_BASELINE).state()).versions.find(v => v.id === parsed.data.versionId)
        } catch {
          return c.json({ error: 'Version storage is unavailable; no model call was made.', code: 'storage_unavailable' }, 503)
        }
        if (!version) return c.json({ error: 'That saved version is unavailable. Refresh and select a version.' }, 404)
        try {
          return c.json(await runMannyTest(version, parsed.data))
        } catch (failure) {
          const detail = failure as { name?: unknown; code?: unknown; statusCode?: unknown } | null
          const safe = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : undefined
          console.error('Manny private chat failed', { phase: 'generation', errorName: safe(detail?.name), errorCode: safe(detail?.code), statusCode: typeof detail?.statusCode === 'number' && Number.isInteger(detail.statusCode) && detail.statusCode >= 100 && detail.statusCode <= 599 ? detail.statusCode : undefined })
          return c.json({ error: 'Manny could not complete this Fireworks request. Check the selected model and provider account. Your message is kept; retry manually.', code: 'generation_failed' }, 502)
        }
      }
      let input: unknown
      if (action !== 'state') {
        try { input = await c.req.json() } catch { return c.json({ error: 'invalid JSON', fieldErrors: { body: ['Expected JSON'] } }, 400) }
        const result = (action === 'save' ? saveSchema : action === 'activate' ? activateSchema : restoreSchema).safeParse(input)
        if (!result.success) return c.json({ error: 'invalid settings request', fieldErrors: result.error.flatten().fieldErrors }, 400)
        input = result.data
      }
      try {
        const db = await readySettingsDb(c.get('mastra'))
        if (!db) return c.json({ error: 'Settings database unavailable; changes are not saved', code: 'storage_unavailable' }, 503)
        const baseline = MANNY_BASELINE
        const store = new PgSettingsStore(db, baseline)
        if (action === 'state') {
          return c.json({ ...(await store.state()), baseline, photos: photoCards(), capabilities: {
            persistent: true,
            laya: 'unavailable: required artifact and invocation have not been recovered',
            memoryAvailable: Boolean(process.env.DATABASE_URL),
            hindsightAvailable: process.env.HINDSIGHT_ENABLED === 'true' && Boolean(process.env.HINDSIGHT_API_KEY) && process.env.PAPERCLIP_COMPANY_ID === DYNAMITE_COMPANY_ID,
            customerSendsEnabled: process.env.GHL_SEND_ENABLED === 'true',
            baselineIdentity: 'current preserved setup; last personally used model is unverified',
            chat: testChatAvailability(),
          } })
        }
        if (action === 'save') {
          const body = input as z.infer<typeof saveSchema>
          return c.json({ version: await store.save(body.label, body.settings) })
        }
        if (action === 'activate') {
          const body = input as z.infer<typeof activateSchema>
          return c.json({ active: await store.activate(body.versionId, body.expectedActiveId) })
        }
        const body = input as z.infer<typeof restoreSchema>
        return c.json({ version: await store.restore(body.versionId, body.label) })
      } catch (failure) {
        if (failure instanceof z.ZodError) return c.json({ error: 'invalid settings', fieldErrors: failure.flatten().fieldErrors }, 400)
        const status = (failure as { status?: number }).status
        if (status === 409) return c.json({ error: 'Active version changed or selected version does not exist; refresh settings' }, 409)
        if (status === 404) return c.json({ error: 'Settings version does not exist' }, 404)
        if (status === 400) return c.json({ error: 'Credentials cannot be saved in settings or labels', fieldErrors: { label: ['Remove credentials'] } }, 400)
        return c.json({ error: 'Settings database unavailable; changes are not saved', code: 'storage_unavailable' }, 503)
      }
    },
  })
}
export const controlSettingsRoutes = [
  route('/dynamite/settings', 'state'),
  route('/dynamite/settings/photos/:photoId', 'photo'),
  route('/dynamite/settings/save', 'save'),
  route('/dynamite/settings/activate', 'activate'),
  route('/dynamite/settings/restore', 'restore'),
  route('/dynamite/settings/chat', 'chat'),
]
