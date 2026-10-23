import { registerSentQuote } from '../src/mastra/followup-runtime.ts'
import { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import { PostgresStore } from '@mastra/pg'
import { RequestContext } from '@mastra/core/request-context'
import { salesAgent, generationOptions } from '../src/mastra/agents/sales-agent.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { PgSettingsStore, defaultSettings, settingsSchema, getRuntimeSettings, type SettingsSql } from '../src/mastra/control-settings.ts'
const require = createRequire(import.meta.url)
function binary(name: string) {
  const brew = `/opt/homebrew/bin/${name}`
  if (existsSync(brew)) return brew
  try { return execFileSync('which', [name], { encoding: 'utf8' }).trim() } catch { return '' }
}
const initdb = binary('initdb'), pgctl = binary('pg_ctl')
let Pool: any
try { ({ Pool } = createRequire(require.resolve('@mastra/pg'))('pg')) } catch {}
// Never load .env: this acceptance owns an ephemeral Unix-socket-only PostgreSQL cluster.
test('settings snapshots: real PostgreSQL drafts, CAS, restore, restart, validation and request pinning', {
  timeout: 60_000,
  skip: !initdb || !pgctl || !Pool ? 'local PostgreSQL binaries and installed driver required' : false,
}, async t => {
  const root = mkdtempSync('/tmp/dynamite-settings-')
  const data = join(root, 'data'), port = 20_000 + Math.floor(Math.random() * 30_000)
  const pools: any[] = []
  let started = false
  function connect(): SettingsSql {
    const pool = new Pool({ host: root, port, user: 'dynamite_test', database: 'postgres', max: 4 })
    pools.push(pool)
    return {
      async none(query, values) { await pool.query(query, values) },
      async any<T>(query: string, values?: unknown[]): Promise<T[]> { return (await pool.query(query, values)).rows },
      async oneOrNone<T>(query: string, values?: unknown[]): Promise<T | null> { const rows = (await pool.query(query, values)).rows; assert.ok(rows.length <= 1); return rows[0] ?? null },
    }
  }
  try {
    execFileSync(initdb, ['-D', data, '-A', 'trust', '-U', 'dynamite_test', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' })
    execFileSync(pgctl, ['-D', data, '-l', join(root, 'server.log'), '-o', `-F -k ${root} -p ${port} -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe' })
    started = true
    const db = connect(), baseline = defaultSettings('Preserved Manny instructions')
    const store = new PgSettingsStore(db, baseline)
    const first = await store.state()
    assert.deepEqual(first.active.settings, baseline)
    assert.equal(first.versions.length, 1)
    assert.equal(first.active.settings.generation.temperature, null)
    assert.deepEqual(first.active.settings.followups.spacingHours, [24, 48, 96, 168])
    const edited = structuredClone(baseline)
    edited.instructions = 'A complete edited prompt'
    edited.generation.temperature = 0.7
    edited.tools.quotePrice = false
    edited.photos.installEnabled = false
    edited.followups.minimumGapHours = 22
    edited.followups.spacingHours = [12, 36]
    edited.memory.lastMessages = 12
    edited.evaluation.sampleRate = 0.4
    edited.hindsight.pageIds = ['sales-rules']
    edited.modelId = 'accounts/acme/models/manny#accounts/acme/deployments/sales'
    const draft = await store.save('Complete draft', edited)
    assert.deepEqual(draft.settings, edited)
    assert.equal((await store.state()).active.id, first.active.id, 'save must never activate')
    assert.deepEqual((await new PgSettingsStore(connect(), baseline).state()).versions.find(v => v.id === draft.id)?.settings, edited)
    const requestContext = { get: () => ({ instructions: 'untrusted client override' }) }
    const mastra = { getStorage: () => ({ db }) }
    const pinned = await getRuntimeSettings({ mastra, requestContext }, baseline)
    const outcomes = await Promise.allSettled([store.activate(draft.id, first.active.id), store.activate(first.active.id, first.active.id)])
    // A same-ID activation is a harmless no-op; use two distinct drafts to prove exclusive CAS.
    const current = (await store.state()).active
    const a = await store.save('A', edited), b = await store.save('B', baseline)
    const race = await Promise.allSettled([store.activate(a.id, current.id), store.activate(b.id, current.id)])
    assert.equal(race.filter(r => r.status === 'fulfilled').length, 1)
    const conflict = race.find(r => r.status === 'rejected') as PromiseRejectedResult
    assert.equal(conflict.reason.status, 409)
    assert.ok(outcomes.some(r => r.status === 'fulfilled'))
    assert.equal((await getRuntimeSettings({ mastra, requestContext }, baseline)).id, pinned.id)
    assert.equal(pinned.id, first.active.id)
    // Real Mastra hooks read the same database snapshot; no model inference occurs.
    const nativeStore = new PostgresStore({ id: 'settings-runtime-acceptance', host: root, port, user: 'dynamite_test', password: 'offline-trust-fixture', database: 'postgres', disableInit: true })
    try {
      new Mastra({ agents: { salesAgent }, storage: nativeStore })
      const active = await store.active()
      const configured = await store.save('Native hooks', edited)
      await store.activate(configured.id, active.id)
      const context = new RequestContext()
      assert.equal(await salesAgent.getInstructions({ requestContext: context }), edited.instructions)
      assert.equal((await salesAgent.listTools({ requestContext: context })).quotePrice, undefined)
      assert.ok((await salesAgent.listTools({ requestContext: context })).showRapportPhoto)
      assert.equal(generationOptions(edited).modelSettings.temperature, 0.7)
      const model = await salesAgent.getModel({ requestContext: context })
      assert.equal(model.modelId.replace(/^fireworks-ai\//, ''), edited.modelId)
      const tools = await salesAgent.listTools({ requestContext: context })
      const picked = await (tools.showInstallPhoto.execute as any)({}, { requestContext: context })
      assert.equal(picked.attached, false, 'saved photo disable reaches real tool execution')
      const quoteAt = new Date('2026-10-15T12:00:00Z')
      const tasks = await registerSentQuote(db, { contactId: 'saved-settings-quote', quoteRef: 'offline-quote', quoteSentAt: quoteAt }, configured)
      assert.equal(tasks.length, 2)
      assert.equal(tasks[0].due_at.toISOString(), '2026-10-16T00:00:00.000Z')
      assert.deepEqual(tasks[0].payload.followupPlan, edited.followups)
      assert.equal(tasks[0].payload.settingsVersionId, configured.id)

      const changed = await store.save('Later settings', { ...edited, instructions: 'Later prompt' })
      await store.activate(changed.id, configured.id)
      assert.equal(await salesAgent.getInstructions({ requestContext: context }), edited.instructions, 'in-flight request keeps pinned version')
      assert.equal(await salesAgent.getInstructions({ requestContext: new RequestContext() }), 'Later prompt')
    } finally { await nativeStore.close() }
    const activeBeforeRestore = (await store.state()).active.id
    const restored = await store.restore(draft.id, 'Restored copy')
    assert.notEqual(restored.id, draft.id)
    assert.equal(restored.hash, draft.hash)
    assert.deepEqual(restored.settings, edited)
    assert.equal((await store.state()).active.id, activeBeforeRestore)
    const unsafe = [
      { ...baseline, apiKey: 'secret' },
      { ...baseline, followups: { ...baseline.followups, spacingHours: [48, 24] } },
      { ...baseline, followups: { ...baseline.followups, spacingHours: [1, 2, 3, 4, 5] } },
      { ...baseline, followups: { ...baseline.followups, lines: ['one line'] } },
      { ...baseline, hindsight: { ...baseline.hindsight, pageIds: ['  '] } },
      { ...baseline, modelId: 'https://api.example.com/model' },
      { ...baseline, instructions: 'postgresql://admin:password@db.example.com/live' },
      { ...baseline, instructions: 'api_key=sk-secret-value' },
      { ...baseline, photos: { ...baseline.photos, disabledIds: ['not-a-photo'] } },
      { ...baseline, photos: { ...baseline.photos, overrides: [{ id: 'rooftop-01', url: 'https://example.com/arbitrary-replacement.jpg', caption: null }] } },
      { ...baseline, hindsight: { ...baseline.hindsight, bankId: 'alex-agents' } },
    ]
    const before = (await store.state()).versions.length
    for (const settings of unsafe) {
      assert.equal(settingsSchema.safeParse(settings).success, false)
      await assert.rejects(store.save('Unsafe', settings))
    }
    await assert.rejects(store.save('postgres://user:pass@host/db', baseline))
    assert.equal((await store.state()).versions.length, before)
    assert.doesNotMatch(JSON.stringify(await store.state()), /sk-secret-value|admin:password|untrusted client override/)
    await t.test('private chat uses an inactive saved snapshot and real approved photo tools without live CRM access', async () => {
      const { controlSettingsRoutes } = await import('../src/mastra/routes/control-settings.ts')
      const { PHOTOS } = await import('../src/mastra/photos.ts')
      const route = controlSettingsRoutes.find(r => r.path === '/dynamite/settings/chat') as any
      const selected = defaultSettings('Saved private prompt: help choose holiday roofline lights.')
      selected.modelId = 'accounts/offline/models/saved-manny#accounts/offline/deployments/private-test'
      selected.generation = { temperature: 0.37, topP: 0.81, maxOutputTokens: 123, maxSteps: 2 }
      selected.tools = { lookupProspect: true, quotePrice: false, proposeDate: false, bookInstall: false, showInstallPhoto: true, showRapportPhoto: false }
      selected.photos.disabledIds = PHOTOS.filter(p => p.id !== 'rooftop-01').map(p => p.id)
      selected.photos.overrides = [{ id: 'rooftop-01', caption: 'Saved caption: we handle the ladders.' }]
      const saved = await store.save('Private chat inactive snapshot', selected)
      const activeId = (await store.active()).id
      assert.notEqual(saved.id, activeId, 'chat must support saved versions before activation')
      const envNames = ['MASTRA_API_TOKEN', 'FIREWORKS_API_KEY', 'MANNY_CHAT_ENABLED', 'GHL_API_KEY', 'GHL_LOCATION_ID'] as const
      const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]))
      const originalGenerate = Agent.prototype.generate
      const calls: Array<{ messages: unknown; options: any; tools: any; photo: any; crm: any }> = []
      let shouldFail = false, longReply = false
      const body = { versionId: saved.id, history: [{ role: 'user', content: 'I am comparing styles.' }, { role: 'assistant', content: 'this is Marvin from Dynamite.' }], message: 'Who handles the ladders?', conversationId: 'offline-private-chat' }
      async function request(payload: unknown = body, token = 'Bearer offline-chat-route-token', brokenJson = false) {
        const headers: Record<string, string> = {}
        return route.handler({
          req: { header: () => token, json: async () => { if (brokenJson) throw Error('invalid JSON'); return payload } },
          header: (key: string, value: string) => { headers[key.toLowerCase()] = value },
          get: () => ({ getStorage: () => ({ db }) }),
          json: (payload: any, status = 200) => ({ payload, status, headers }),
        })
      }
      try {
        process.env.MASTRA_API_TOKEN = 'offline-chat-route-token'
        process.env.FIREWORKS_API_KEY = 'offline-placeholder'
        process.env.MANNY_CHAT_ENABLED = 'true'
        // Populated placeholders ensure the private CRM stub, rather than missing credentials,
        // prevents lookup. Only the external inference boundary is mocked.
        process.env.GHL_API_KEY = 'offline-placeholder'
        process.env.GHL_LOCATION_ID = 'offline-location'
        Agent.prototype.generate = async function (messages: any, options: any) {
          if (shouldFail) throw Error('offline provider failure')
          const context = { requestContext: options.requestContext }
          assert.equal(await this.getInstructions(context), selected.instructions)
          assert.equal((await this.getModel(context)).modelId.replace(/^fireworks-ai\//, ''), selected.modelId)
          const tools = await this.listTools(context)
          assert.deepEqual(Object.keys(tools).sort(), ['lookupProspect', 'showInstallPhoto'])
          const crm = await (tools.lookupProspect.execute as any)({ phone: '+15555550100' }, context)
          assert.deepEqual(crm, { found: false, name: '', stage: '', notes: ['Private dashboard test: no live CRM contact lookup. Use the conversation supplied.'], opportunities: [] })
          const photo = await (tools.showInstallPhoto.execute as any)({ style: 'safety' }, context)
          calls.push({ messages, options, tools, photo, crm })
          return { text: longReply ? 'warm white looks lovely '.repeat(200)+'Just the front or front and side?' : 'We handle the ladders. Just the front or front and side?', steps: [{ toolCalls: [{ payload: { toolName: 'lookupProspect' } }, { toolName: 'showInstallPhoto' }] }], usage: { totalTokens: 12 } } as any
        } as typeof Agent.prototype.generate
        const response = await request()
        assert.equal(response.status, 200)
        assert.equal(response.headers['cache-control'], 'no-store')
        assert.equal(response.payload.settingsVersionId, saved.id)
        assert.equal(response.payload.modelId, selected.modelId)
        assert.equal(response.payload.photoId, 'rooftop-01')
        assert.equal(PHOTOS.find(p => p.id === response.payload.photoId)?.consent, 'granted')
        assert.deepEqual(response.payload.toolsUsed, ['lookupProspect', 'showInstallPhoto'])
        assert.deepEqual(response.payload.usage, { totalTokens: 12 })
        assert.match(response.payload.laya, /unverified/)
        assert.equal(calls.length, 1)
        assert.deepEqual(calls[0].messages, [...body.history, { role: 'user', content: body.message }])
        assert.equal(calls[0].options.instructions, `${selected.instructions}\n\nYour name in this conversation: Marvin.`)
        assert.equal(calls[0].options.maxSteps, 2)
        assert.deepEqual(calls[0].options.modelSettings, { temperature: 0.37, topP: 0.81, maxOutputTokens: 123 })
        assert.equal(calls[0].photo.attached, true)
        assert.equal(calls[0].photo.shows, 'Saved caption: we handle the ladders.')
        assert.equal(calls[0].options.requestContext.get('photoIncludePending'), false)
        const repeated = await request({ ...body, history: [...body.history, { role: 'assistant', content: response.payload.reply, photoId: 'rooftop-01' }] })
        assert.equal(repeated.status, 200)
        assert.equal(repeated.payload.photoId, '', 'the real photo tool cannot repeat a photo in the supplied conversation')
        assert.equal(calls[1].photo.attached, false)
        const disabled = await store.save('Photos off in private chat', { ...selected, photos: { ...selected.photos, installEnabled: false } })
        const noPhoto = await request({ ...body, versionId: disabled.id })
        assert.equal(noPhoto.status, 200)
        assert.equal(noPhoto.payload.photoId, '')
        assert.equal(calls[2].photo.attached, false, 'saved photo disable reaches real tool execution')
        longReply = true
        const long = await request()
        assert.equal(long.status, 200)
        assert.ok(long.payload.reply.length <= 4000, 'a returned reply must fit the next-turn history contract')
        assert.equal(long.payload.replyTruncated, true)
        const { testChatSchema } = await import('../src/mastra/control-chat.ts')
        assert.equal(testChatSchema.safeParse({ ...body, history: [...body.history, { role: 'assistant', content: long.payload.reply }] }).success, true)
        longReply = false
        const beforeRejected = calls.length
        assert.equal((await request({ ...body, versionId: 'missing-offline-version' })).status, 404)
        assert.equal((await request({ ...body, message: '   ' })).status, 400)
        assert.equal((await request({ ...body, instructions: 'client override' })).status, 400)
        assert.equal((await request(body, 'Bearer wrong')).status, 401)
        assert.equal((await request(body, 'Bearer offline-chat-route-token', true)).status, 400)
        delete process.env.FIREWORKS_API_KEY
        const missingKey = await request()
        assert.equal(missingKey.status, 503)
        assert.equal(missingKey.payload.code, 'provider_not_configured')
        process.env.FIREWORKS_API_KEY = 'offline-placeholder'
        process.env.MANNY_CHAT_ENABLED = 'false'
        const notEnabled = await request()
        assert.equal(notEnabled.status, 503)
        assert.equal(notEnabled.payload.code, 'chat_not_enabled')
        assert.equal(calls.length, beforeRejected, 'all rejected requests fail before inference')
        process.env.MANNY_CHAT_ENABLED = 'true'
        shouldFail = true
        const failed = await request()
        assert.equal(failed.status, 502)
        assert.equal(failed.payload.code, 'generation_failed')
        assert.doesNotMatch(JSON.stringify(failed.payload), /offline provider failure|offline-placeholder/)
        assert.equal((await store.active()).id, activeId, 'chat never activates a saved version')
      } finally {
        Agent.prototype.generate = originalGenerate
        for (const name of envNames) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name] }
      }
    })
  } finally {
    await Promise.all(pools.map(p => p.end()))
    if (started) execFileSync(pgctl, ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' })
    rmSync(root, { recursive: true, force: true })
  }
})

test('settings routes require explicit bearer match and never cache or expose credentials', async () => {
  const { controlSettingsRoutes } = await import('../src/mastra/routes/control-settings.ts')
  const previous = process.env.MASTRA_API_TOKEN
  process.env.MASTRA_API_TOKEN = 'offline-settings-test-token'
  async function request(path: string, token: string, body?: unknown, db?: SettingsSql) {
    const route = controlSettingsRoutes.find(r => r.path === path) as any
    assert.ok(route, `registered route ${path}`)
    assert.equal(route.requiresAuth, true)
    const headers: Record<string, string> = {}
    const context = {
      req: { header: (name: string) => name === 'authorization' ? token : undefined, json: async () => body },
      header: (key: string, value: string) => { headers[key.toLowerCase()] = value },
      get: () => ({ getStorage: () => ({ db }) }),
      json: (payload: unknown, status = 200) => ({ status, payload, headers }),
    }
    return route.handler(context)
  }
  try {
    const unauthorized = await request('/dynamite/settings', 'Bearer wrong')
    assert.equal(unauthorized.status, 401)
    assert.equal(unauthorized.headers['cache-control'], 'no-store')
    const unavailable = await request('/dynamite/settings', 'Bearer offline-settings-test-token')
    assert.equal(unavailable.status, 503)
    assert.doesNotMatch(JSON.stringify(unavailable), /offline-settings-test-token/)
    const invalid = await request('/dynamite/settings/save', 'Bearer offline-settings-test-token', { label: 'bad', settings: {} })
    assert.equal(invalid.status, 400)
    assert.ok(invalid.payload.fieldErrors)
    for (const path of ['/dynamite/settings/save', '/dynamite/settings/activate', '/dynamite/settings/restore']) {
      assert.equal((await request(path, 'Bearer wrong', {})).status, 401)
    }
  } finally {
    if (previous === undefined) delete process.env.MASTRA_API_TOKEN
    else process.env.MASTRA_API_TOKEN = previous
  }
})

test('protected local photo previews work without a database and reject unknown files', async () => {
  const { controlSettingsRoutes } = await import('../src/mastra/routes/control-settings.ts')
  const { PHOTOS } = await import('../src/mastra/photos.ts')
  const route = controlSettingsRoutes.find(r => r.path === '/dynamite/settings/photos/:photoId') as any
  assert.ok(route, 'protected photo preview route is registered')
  assert.equal(route.requiresAuth, true)
  const previousToken = process.env.MASTRA_API_TOKEN, previousDir = process.env.MANNY_PHOTO_DIR
  process.env.MASTRA_API_TOKEN = 'offline-preview-token'
  async function request(id: string, authorization: string) {
    const headers: Record<string, string> = {}
    return route.handler({
      req: { header: () => authorization, param: () => id },
      header: (k: string, v: string) => { headers[k.toLowerCase()] = v },
      get: () => { throw Error('Photo preview must not need a DB') },
      json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers }),
    })
  }
  try {
    assert.equal((await request(PHOTOS[0].id, 'Bearer wrong')).status, 401)
    assert.equal((await request('../private', 'Bearer offline-preview-token')).status, 404)
    const image = await request(PHOTOS[0].id, 'Bearer offline-preview-token')
    assert.equal(image.status, 200)
    assert.equal(image.headers.get('cache-control'), 'no-store')
    assert.equal(image.headers.get('content-type'), 'image/jpeg')
    const bytes = new Uint8Array(await image.arrayBuffer())
    assert.equal(bytes[0], 0xff)
    assert.equal(bytes[1], 0xd8)
    process.env.MANNY_PHOTO_DIR = '/tmp/nonexistent-manny-photo-fixture'
    assert.equal((await request(PHOTOS[0].id, 'Bearer offline-preview-token')).status, 404)
  } finally {
    if (previousToken === undefined) delete process.env.MASTRA_API_TOKEN; else process.env.MASTRA_API_TOKEN = previousToken
    if (previousDir === undefined) delete process.env.MANNY_PHOTO_DIR; else process.env.MANNY_PHOTO_DIR = previousDir
  }
})

test('settings reject recognizable Hindsight and service credential shapes', () => {
  const baseline = defaultSettings('Manny instructions without credentials')
  for (const secret of ['hsk_offlineSecret123456', 'ghp_offlineSecret123456789012345678901234', 'xoxb-offlineSecret123456']) {
    assert.equal(settingsSchema.safeParse({ ...baseline, instructions: `Connection credential ${secret}` }).success, false)
  }
  assert.equal(settingsSchema.safeParse({ ...baseline, instructions: 'Ask a friendly question about their roofline.' }).success, true)
})


test('photo overrides edit captions while rejecting arbitrary replacement URLs', () => {
  const baseline = defaultSettings('Preserved Manny instructions')
  assert.equal(settingsSchema.safeParse({ ...baseline, photos: { ...baseline.photos, overrides: [{ id: 'rooftop-01', caption: 'Existing install caption' }] } }).success, true)
  assert.equal(settingsSchema.safeParse({ ...baseline, photos: { ...baseline.photos, overrides: [{ id: 'rooftop-01', caption: null, url: 'https://example.com/arbitrary-replacement.jpg' }] } }).success, false)
})

test('Manny can be tested from a protected saved-version chat route', async () => {
  const { controlSettingsRoutes } = await import('../src/mastra/routes/control-settings.ts')
  const route = controlSettingsRoutes.find(r => r.path === '/dynamite/settings/chat') as any
  assert.ok(route, 'the settings dashboard needs a chat endpoint, not only settings forms')
  assert.equal(route.requiresAuth, true)
  const previous = process.env.MASTRA_API_TOKEN
  process.env.MASTRA_API_TOKEN = 'offline-settings-test-token'
  try {
    const response = await route.handler({
      req: { header: () => undefined }, header: () => {},
      json: (body: unknown, status = 200) => ({ body, status }),
    })
    assert.equal(response.status, 401)
  } finally { if (previous === undefined) delete process.env.MASTRA_API_TOKEN; else process.env.MASTRA_API_TOKEN = previous }
})

test('settings SQL waits for native storage init and init failure stops chat before generation', async () => {
  const { controlSettingsRoutes } = await import('../src/mastra/routes/control-settings.ts')
  const previous = { token: process.env.MASTRA_API_TOKEN, key: process.env.FIREWORKS_API_KEY, enabled: process.env.MANNY_CHAT_ENABLED }
  const originalGenerate = Agent.prototype.generate
  let queries = 0, generated = 0, initialized = false
  let resolveInit!: () => void
  const deferred = new Promise<void>(resolve => { resolveInit = () => { initialized = true; resolve() } })
  const db = {
    none: async () => { queries++; assert.equal(initialized, true); throw Error('offline SQL stop') },
    any: async () => [], oneOrNone: async () => null,
  }
  const request = (path: string, storage: object) => {
    const route = controlSettingsRoutes.find(r => r.path === path) as any
    return route.handler({
      req: { header: () => 'Bearer offline-init-test', json: async () => ({ versionId: 'offline', message: 'hello', history: [], conversationId: 'offline-init-test' }) },
      header() {}, get: () => ({ getStorage: () => storage }),
      json: (payload: unknown, status = 200) => ({ payload, status }),
    })
  }
  try {
    process.env.MASTRA_API_TOKEN = 'offline-init-test'
    process.env.FIREWORKS_API_KEY = 'offline-placeholder'
    process.env.MANNY_CHAT_ENABLED = 'true'
    Agent.prototype.generate = async function () { generated++; throw Error('must not generate') } as any
    const pending = request('/dynamite/settings', { init: () => deferred, db })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(queries, 0, 'raw settings SQL must wait for native init')
    resolveInit()
    assert.equal((await pending).status, 503)
    assert.equal(queries, 1, 'settings SQL starts only after successful init')
    const failure = await request('/dynamite/settings/chat', { init: async () => { throw Error('private connection details') }, db })
    assert.equal(failure.status, 503)
    assert.equal(failure.payload.code, 'storage_unavailable')
    assert.doesNotMatch(JSON.stringify(failure), /private connection details|offline-placeholder/)
    assert.equal(queries, 1, 'failed native init must prevent raw SQL')
    assert.equal(generated, 0)
    let runtimeSql = 0, releaseRuntime!: () => void
    const runtimeInit = new Promise<void>(resolve => { releaseRuntime = resolve })
    const runtimeDb = { ...db, none: async () => { runtimeSql++; throw Error('offline runtime stop') } }
    const runtime = getRuntimeSettings({ mastra: { getStorage: () => ({ init: () => runtimeInit, db: runtimeDb }) } }, defaultSettings('offline')).catch(() => null)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(runtimeSql, 0, 'runtime settings use the same native init barrier')
    releaseRuntime()
    await runtime
    assert.equal(runtimeSql, 1)
  } finally {
    resolveInit()
    Agent.prototype.generate = originalGenerate
    for (const [name, value] of Object.entries({ MASTRA_API_TOKEN: previous.token, FIREWORKS_API_KEY: previous.key, MANNY_CHAT_ENABLED: previous.enabled })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  }
})

test('concurrent runtime hooks pin one active settings read before deferred native init', async () => {
  let release!: () => void, reads = 0, initCalls = 0
  const init = new Promise<void>(resolve => { release = resolve })
  const settings = defaultSettings('offline concurrency fixture')
  const db = {
    none: async () => null,
    any: async () => [],
    oneOrNone: async () => ({ id: `version-${++reads}`, label: 'fixture', settings, created_at: new Date(0), hash: 'fixture' }),
  }
  const options = { requestContext: {}, mastra: { getStorage: () => ({ init: () => { initCalls++; return init }, db }) } }
  const first = getRuntimeSettings(options, settings)
  const second = getRuntimeSettings(options, settings)
  release()
  const versions = await Promise.all([first, second])
  assert.equal(reads, 1, 'same request must not see two active snapshots')
  assert.equal(initCalls, 1, 'pin the shared resolver before native init settles')
  assert.equal(versions[0].id, versions[1].id)
})
