import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ghlSmsPayload, limitMedia, photoUrl, pickPhoto, PHOTOS, REVIEW_QUOTE } from '../src/mastra/photos.ts'
import { showInstallPhoto } from '../src/mastra/tools/show-photo.ts'

test('library holds the 10 send-safe installs (14 is the same scene as 07), never the review screenshot or the non-install photo', () => {
  assert.equal(PHOTOS.length, 10)
  assert.ok(PHOTOS.every(p => p.consent === 'granted'))
  const files = PHOTOS.map(p => p.file).join(' ')
  assert.doesNotMatch(files, /05|06|alex-upload/)
  assert.ok(PHOTOS.every(p => p.file.startsWith('dyn-') && p.file.endsWith('.jpg')))
  assert.equal(REVIEW_QUOTE.attribution, 'a customer in Troy')
})

test('color questions get a matching photo', () => {
  assert.deepEqual(pickPhoto({ color: 'warm white' }, [], true)?.colors, ['warm white'])
  assert.equal(pickPhoto({ color: 'multicolor' }, [], true)?.id, 'multicolor-04')
  assert.equal(pickPhoto({ color: 'rainbow colors' }, [], true)?.id, 'multicolor-04')
  assert.equal(pickPhoto({ color: 'all red' }, [], true)?.colors.includes('red'), true)
})

test('ladder worries get a rooftop install photo', () => {
  assert.match(pickPhoto({ style: 'safety' }, [], true)?.id ?? '', /^rooftop-/)
})

test('never repeats a photo inside a conversation', () => {
  const first = pickPhoto({ color: 'warm white' }, [], true)!
  const second = pickPhoto({ color: 'warm white' }, [first.id], true)!
  assert.notEqual(first.id, second.id)
  assert.equal(pickPhoto({}, PHOTOS.map(p => p.id), true), null)
})

test('no photo when nothing fits', () => {
  assert.equal(pickPhoto({ color: 'purple' }, [], true), null)
})

test('at most one attachment per reply', () => {
  assert.deepEqual(limitMedia(['a', 'b']), ['a'])
  assert.deepEqual(limitMedia(['']), [])
})

test('no URL until the library is hosted', () => {
  assert.equal(photoUrl(PHOTOS[0], ''), null)
  assert.equal(photoUrl(PHOTOS[0], 'https://cdn.example.com/dyn/'), `https://cdn.example.com/dyn/${PHOTOS[0].file}`)
})

function ctx(initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initial))
  return { requestContext: { get: (k: string) => store.get(k), set: (k: string, v: unknown) => store.set(k, v) }, store }
}

test('tool attaches one photo per text and skips ones already sent', async () => {
  const c = ctx({ photosSent: ['multicolor-04'], photoIncludePending: true })
  const execute = showInstallPhoto.execute as (input: unknown, context: unknown) => Promise<{ attached: boolean; photoId: string }>
  const none = await execute({ color: 'multicolor' }, c)
  assert.equal(none.attached, false)
  const first = await execute({ color: 'warm white' }, c)
  assert.equal(first.attached, true)
  const again = await execute({ color: 'red' }, c)
  assert.equal(again.attached, false)
  assert.equal(c.store.get('photoPicked'), first.photoId)
})

test('no photo once the deal is confirmed or estimated', async () => {
  const execute = showInstallPhoto.execute as (input: unknown, context: unknown) => Promise<{ attached: boolean }>
  for (const dealState of ['CONFIRMED', 'ESTIMATE_SENT']) {
    const c = ctx({ dealState, photoIncludePending: true })
    assert.equal((await execute({ color: 'warm white' }, c)).attached, false)
    assert.equal(c.store.get('photoPicked'), undefined)
  }
  assert.equal((await execute({ color: 'warm white' }, ctx({ dealState: 'QUALIFIED' }))).attached, true)
})

test('pending-consent photos are never picked for live sends', () => {
  assert.ok(PHOTOS.every(p => p.consent === 'pending' || p.consent === 'granted'))
  if (PHOTOS.every(p => p.consent === 'pending')) assert.equal(pickPhoto({ color: 'warm white' }), null)
  assert.notEqual(pickPhoto({ color: 'warm white' }, [], true), null)
})

test('GHL payload carries at most one attachment and none when there is no media', () => {
  assert.deepEqual(ghlSmsPayload('c1', 'hey', ['https://x/a.jpg', 'https://x/b.jpg']), {
    type: 'SMS', contactId: 'c1', message: 'hey', attachments: ['https://x/a.jpg'],
  })
  assert.deepEqual(ghlSmsPayload('c1', 'hey', []), { type: 'SMS', contactId: 'c1', message: 'hey' })
})

test('a per-photo hosted URL wins over the base prefix', () => {
  const hosted = { ...PHOTOS[0], url: 'https://storage.example/abc123.jpg' }
  assert.equal(photoUrl(hosted, 'https://cdn.example.com/dyn'), 'https://storage.example/abc123.jpg')
})

test('saved photo settings disable installs and change captions without replacing approved images', () => {
  const settings = { installEnabled: false, rapportEnabled: true, disabledIds: [], overrides: [] }
  assert.equal(pickPhoto({}, [], true, settings), null)
  const enabled = { ...settings, installEnabled: true, overrides: [{ id: PHOTOS[0].id, caption: 'a saved caption', url: 'https://cdn.example.com/saved.jpg' }] }
  const photo = pickPhoto({}, [], true, enabled)!
  assert.equal(photo.id, PHOTOS[0].id)
  assert.equal(photo.hook, 'a saved caption')
  assert.equal(photoUrl(photo), photoUrl(PHOTOS[0]), 'a caption override cannot transfer consent to a replacement image')
  assert.notEqual(PHOTOS[0].hook, 'a saved caption', 'version edits must not mutate the preserved library')
  assert.notEqual(pickPhoto({}, [], true, { ...enabled, disabledIds: [PHOTOS[0].id] })?.id, PHOTOS[0].id)
})

test('07 and 14 are the same scene: sending one rules out the other', () => {
  const left = new Set<string>()
  let p = pickPhoto({ style: 'safety' }, ['rooftop-07', 'rooftop-01'])
  assert.notEqual(p?.id, 'rooftop-high-14')
  p = pickPhoto({ style: 'safety' }, ['rooftop-high-14', 'rooftop-01'])
  assert.notEqual(p?.id, 'rooftop-07')
  void left
})

test('rapport photos: never first reply, only after back-and-forth, once per conversation, sparing', async () => {
  const { rapportAllowed, pickRapport, speakerName, RAPPORT } = await import('../src/mastra/photos.ts')
  assert.equal(RAPPORT.length, 2)
  const keys = Array.from({ length: 300 }, (_, i) => `+1555${String(i).padStart(7, '0')}`)
  assert.equal(keys.filter(k => rapportAllowed({ customerTurns: 1, rapportAlreadySent: false, leadKey: k })).length, 0)
  const allowed = keys.filter(k => rapportAllowed({ customerTurns: 4, rapportAlreadySent: false, leadKey: k })).length
  assert.ok(allowed > 50 && allowed < 150, `sparing: ${allowed}/300`)
  assert.equal(keys.filter(k => rapportAllowed({ customerTurns: 6, rapportAlreadySent: true, leadKey: k })).length, 0)
  assert.equal(pickRapport('x', RAPPORT.map(r => r.id)), null)
  assert.equal(speakerName(''), 'Manny')
  assert.equal(speakerName('hi its Chris from Dynamite'), 'Chris')
})
