import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { resolveSalesModel } from './sales-model.ts'
import { FOLLOWUP_LINES, SPACING_HOURS } from './followups.ts'
import { DYNAMITE_COMPANY_ID } from './customer-context.ts'
import { PHOTOS, RAPPORT, photoUrl } from './photos.ts'

export type SettingsSql = {
  none(query: string, values?: unknown[]): Promise<unknown>
  any<T = Record<string, unknown>>(query: string, values?: unknown[]): Promise<T[]>
  oneOrNone<T = Record<string, unknown>>(query: string, values?: unknown[]): Promise<T | null>
}
const configuredPages = () => (process.env.HINDSIGHT_PAGE_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean)
const bankId = `paperclip::${DYNAMITE_COMPANY_ID}`
const knownPhotos = new Set([...PHOTOS, ...RAPPORT].map(p => p.id))
const text = z.string().max(100_000)
const photoId = z.string().refine(id => knownPhotos.has(id), 'Unknown photo ID')
const httpsUrl = z.string().url().refine(value => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && ![...url.searchParams.keys()].some(k => /token|key|secret|signature|credential/i.test(k))
}, 'Use a public HTTPS photo URL without credentials')
function containsCredential(value: unknown): boolean {
  if (typeof value === 'string') {
    if (/(?:postgres(?:ql)?|mongodb(?:\+srv)?):\/\/|\bBearer\s+\S+|\b(?:sk-|fw_|hsk_|ghp_|github_pat_|xox[baprs]-)[a-zA-Z0-9_-]{8,}|\bAKIA[A-Z0-9]{16}\b|\bAIza[A-Za-z0-9_-]{35}\b|\b(?:api[_ -]?key|access[_ -]?token|secret|password)\s*[=:]\s*\S+/i.test(value)) return true
    return Object.entries(process.env).some(([key, secret]) => /(?:API_KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL)$/.test(key) && secret && secret.length >= 12 && value.includes(secret))
  }
  if (Array.isArray(value)) return value.some(containsCredential)
  return Boolean(value && typeof value === 'object' && Object.values(value).some(containsCredential))
}
export const settingsSchema = z.object({
  modelId: z.string().regex(/^accounts\/[A-Za-z0-9_-]+\/(?:models|deployments)\/[A-Za-z0-9_.-]+(?:#accounts\/[A-Za-z0-9_-]+\/deployments\/[A-Za-z0-9_.-]+)?$/, 'Use an exact Fireworks account model or deployment resource'),
  instructions: text.min(1),
  generation: z.object({ temperature: z.number().min(0).max(2).nullable(), topP: z.number().min(0).max(1).nullable(), maxOutputTokens: z.number().int().min(1).max(1_000_000).nullable(), maxSteps: z.number().int().min(1).max(100) }).strict(),
  tools: z.object({ lookupProspect: z.boolean(), quotePrice: z.boolean(), proposeDate: z.boolean(), bookInstall: z.boolean(), showInstallPhoto: z.boolean(), showRapportPhoto: z.boolean() }).strict(),
  photos: z.object({ installEnabled: z.boolean(), rapportEnabled: z.boolean(), disabledIds: z.array(photoId).max(1000), overrides: z.array(z.object({ id: photoId, caption: text.nullable() }).strict()).max(1000) }).strict().refine(p => new Set(p.overrides.map(o => o.id)).size === p.overrides.length, 'Duplicate photo overrides'),
  followups: z.object({ enabled: z.boolean(), spacingHours: z.array(z.number().positive().max(8760)).min(1).max(4), minimumGapHours: z.number().min(0).max(8760), lines: z.array(text.min(1)).min(1).max(100), quietStart: z.number().int().min(0).max(23), quietEnd: z.number().int().min(0).max(23), timeZone: z.string().refine(s => { try { new Intl.DateTimeFormat('en', { timeZone: s }); return true } catch { return false } }, 'Unknown time zone'), personalAfterHours: z.number().min(0).max(8760), callCooldownMinutes: z.number().min(0).max(10080) }).strict().refine(f => f.spacingHours.every((n, i) => i === 0 || n > f.spacingHours[i - 1]), 'Followup spacing must increase').refine(f => new Set(f.lines.map(line => line.trim()).filter(Boolean)).size >= f.spacingHours.length, 'Provide a distinct nonempty line per followup'),
  memory: z.object({ lastMessages: z.number().int().min(0).max(1000), workingMemoryEnabled: z.boolean(), workingMemoryTemplate: text, semanticRecallEnabled: z.boolean(), recallTopK: z.number().int().min(1).max(100), recallMessageRange: z.number().int().min(0).max(100), repExamplesEnabled: z.boolean(), repExamplesCount: z.number().int().min(1).max(100) }).strict(),
  hindsight: z.object({ enabled: z.boolean(), bankId: z.literal(bankId), pageIds: z.array(z.string().min(1).max(128).refine(s => s.trim() === s && s.length > 0, 'Use a nonempty trimmed page ID')).max(3) }).strict(),
  evaluation: z.object({ sampleRate: z.number().min(0).max(1) }).strict(),
}).strict().superRefine((value, ctx) => { if (containsCredential(value)) ctx.addIssue({ code: 'custom', message: 'Credentials and database connection strings cannot be saved in settings' }) })
export type Settings = z.infer<typeof settingsSchema>
export type Version = { id: string; label: string; settings: Settings; createdAt: string; hash: string }
export type PhotoCard = { id: string; file: string; caption: string; url: string | null; consent: string; kind: string }
export function photoCards(): PhotoCard[] {
  return [...PHOTOS.map(p => ({ id: p.id, file: p.file, caption: p.hook, url: photoUrl(p), consent: p.consent, kind: p.kind })), ...RAPPORT.map(p => ({ id: p.id, file: p.file, caption: p.seed, url: photoUrl(p), consent: p.consent, kind: p.kind }))].map(p => ({ ...p, url: p.url && httpsUrl.safeParse(p.url).success && !containsCredential(p.url) ? p.url : null }))
}
export function defaultSettings(instructions: string): Settings {
  return settingsSchema.parse({
    modelId: resolveSalesModel().replace(/^fireworks-ai\//, ''), instructions,
    generation: { temperature: null, topP: null, maxOutputTokens: null, maxSteps: 5 },
    tools: { lookupProspect: true, quotePrice: true, proposeDate: true, bookInstall: true, showInstallPhoto: true, showRapportPhoto: true },
    photos: { installEnabled: true, rapportEnabled: true, disabledIds: [], overrides: [] },
    followups: { enabled: true, spacingHours: [...SPACING_HOURS], minimumGapHours: 20, lines: [...FOLLOWUP_LINES], quietStart: 21, quietEnd: 9, timeZone: 'America/Detroit', personalAfterHours: 3, callCooldownMinutes: 20 },
    memory: { lastMessages: 20, workingMemoryEnabled: true, workingMemoryTemplate: '# Prospect\n- Name:\n- Address given:\n- Areas to light:\n- Photo received:\n- Quote status:\n- Next step:', semanticRecallEnabled: Boolean(process.env.DATABASE_URL), recallTopK: 3, recallMessageRange: 2, repExamplesEnabled: true, repExamplesCount: 5 },
    hindsight: { enabled: process.env.HINDSIGHT_ENABLED === 'true', bankId, pageIds: configuredPages() }, evaluation: { sampleRate: 1 },
  })
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(value)
}
function hash(settings: Settings) { return createHash('sha256').update(canonical(settings)).digest('hex') }
function baselineVersion(settings: Settings): Version { return { id: `baseline-${hash(settings)}`, label: 'Current preserved setup', settings: structuredClone(settings), createdAt: new Date(0).toISOString(), hash: hash(settings) } }
function error(message: string, status: number) { return Object.assign(new Error(message), { status }) }
function version(row: Record<string, any>): Version { return { id: row.id, label: row.label, settings: settingsSchema.parse(row.settings), createdAt: new Date(row.created_at).toISOString(), hash: row.hash } }
const ready = new WeakMap<SettingsSql, Promise<void>>()
export class PgSettingsStore {
  private db: SettingsSql
  private baseline: Settings
  constructor(db: SettingsSql, baseline: Settings) { this.db = db; this.baseline = settingsSchema.parse(baseline) }
  private ensure() {
    let promise = ready.get(this.db)
    if (!promise) {
      promise = (async () => {
        await this.db.none(`CREATE TABLE IF NOT EXISTS manny_settings_versions (id text PRIMARY KEY, label text NOT NULL, settings jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), hash text NOT NULL)`)
        await this.db.none(`CREATE TABLE IF NOT EXISTS manny_settings_active (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), version_id text NOT NULL REFERENCES manny_settings_versions(id))`)
        const baseline = baselineVersion(this.baseline)
        await this.db.none(`INSERT INTO manny_settings_versions (id,label,settings,hash) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [baseline.id, baseline.label, baseline.settings, baseline.hash])
        await this.db.none(`INSERT INTO manny_settings_active (singleton,version_id) VALUES (true,$1) ON CONFLICT (singleton) DO NOTHING`, [baseline.id])
      })().catch(e => { ready.delete(this.db); throw e })
      ready.set(this.db, promise)
    }
    return promise
  }
  async active(): Promise<Version> {
    await this.ensure()
    const row = await this.db.oneOrNone<Record<string, any>>(`SELECT v.* FROM manny_settings_versions v JOIN manny_settings_active a ON a.version_id=v.id WHERE a.singleton=true`)
    if (!row) throw error('Settings active version unavailable', 503)
    return version(row)
  }
  async state(): Promise<{ active: Version; versions: Version[] }> {
    await this.ensure()
    const rows = await this.db.any<Record<string, any>>(`SELECT v.*, (v.id=a.version_id) AS is_active FROM manny_settings_versions v CROSS JOIN manny_settings_active a ORDER BY v.created_at DESC,v.id`)
    const active = rows.find(r => r.is_active)
    if (!active) throw error('Settings active version unavailable', 503)
    return { active: version(active), versions: rows.map(version) }
  }
  async save(label: string, input: Settings): Promise<Version> {
    const settings = settingsSchema.parse(input)
    const checkedLabel = z.string().trim().min(1).max(160).parse(label)
    if (containsCredential(checkedLabel)) throw error('Credentials cannot be saved in labels', 400)
    await this.ensure()
    const row = await this.db.oneOrNone<Record<string, any>>(`INSERT INTO manny_settings_versions (id,label,settings,hash) VALUES ($1,$2,$3,$4) RETURNING *`, [randomUUID(), checkedLabel, settings, hash(settings)])
    if (!row) throw error('Settings version was not saved', 503)
    return version(row)
  }
  async activate(versionId: string, expectedActiveId: string): Promise<Version> {
    await this.ensure()
    const updated = await this.db.oneOrNone<Record<string, any>>(`UPDATE manny_settings_active a SET version_id=v.id FROM manny_settings_versions v WHERE a.singleton=true AND a.version_id=$2 AND v.id=$1 RETURNING v.*`, [versionId, expectedActiveId])
    if (!updated) throw error('Active version changed or selected version does not exist; refresh settings', 409)
    return version(updated)
  }
  async restore(versionId: string, label?: string): Promise<Version> {
    await this.ensure()
    const row = await this.db.oneOrNone<Record<string, any>>(`SELECT * FROM manny_settings_versions WHERE id=$1`, [versionId])
    if (!row) throw error('Settings version does not exist', 404)
    return this.save(label ?? `Restored ${row.label}`.slice(0, 160), version(row).settings)
  }
}
export function settingsDb(mastra?: { getStorage(): unknown }): SettingsSql | null {
  const db = (mastra?.getStorage() as { db?: SettingsSql } | undefined)?.db
  return db && typeof db.none === 'function' && typeof db.any === 'function' && typeof db.oneOrNone === 'function' ? db : null
}
// Raw .db is a property, so Mastra's native method proxy cannot initialize it for us.
export async function readySettingsDb(mastra?: { getStorage(): unknown }): Promise<SettingsSql | null> {
  const storage = mastra?.getStorage() as { init?: () => Promise<unknown>; db?: SettingsSql } | undefined
  if (typeof storage?.init === 'function') await storage.init()
  return settingsDb(storage ? { getStorage: () => storage } : undefined)
}
const pinned = new WeakMap<object, Promise<Version>>()
// The authenticated tester resolves a saved version on the server before pinning it.
// Request-context properties supplied by clients are never settings authority.
export function pinSavedVersion(requestContext: object, version: Version): void {
  if (pinned.has(requestContext)) throw new Error('Settings are already pinned for this request')
  pinned.set(requestContext, Promise.resolve({ ...version, settings: settingsSchema.parse(version.settings) }))
}
export async function getRuntimeSettings(options: { mastra?: { getStorage(): unknown }; requestContext?: object }, baseline: Settings): Promise<Version> {
  let current = options.requestContext && pinned.get(options.requestContext)
  if (!current) {
    current = (async () => {
      const db = await readySettingsDb(options.mastra)
      return db ? new PgSettingsStore(db, baseline).active() : baselineVersion(baseline)
    })()
    if (options.requestContext) pinned.set(options.requestContext, current)
  }
  return current
}
export async function getPinnedSettings(requestContext: object | undefined): Promise<Settings | undefined> {
  const current = requestContext && pinned.get(requestContext)
  return current ? (await current).settings : undefined
}
