import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PHOTOS, RAPPORT } from '../src/mastra/photos.ts'
import { controlSettingsRoutes } from '../src/mastra/routes/control-settings.ts'

// SHA-256 measured directly from the 12 approved library JPEGs, before bundling.
const approved = {
  "rooftop-01": {
    "file": "dyn-rooftop-install-01.jpg",
    "sha256": "8dee16428b25d63922f6cc49e0c75548002b7b35af40843d0e6ec3593739e44f"
  },
  "warmwhite-colonial-02": {
    "file": "dyn-warmwhite-brick-colonial-02.jpg",
    "sha256": "be82534478fde4e26dd7a45877d1c7cdbe5e6df8cab71e28bf9f9828a83f2dab"
  },
  "warmwhite-bushes-03": {
    "file": "dyn-warmwhite-roofline-bushes-03.jpg",
    "sha256": "cb66f102209ddd91f89643661677762a65ef2d4c5741f0634fe5721968eb2391"
  },
  "multicolor-04": {
    "file": "dyn-multicolor-roofline-columns-04.jpg",
    "sha256": "8e8a30e50f4e99eabf00327b4f14cfe73c5e4077b3c1d11afa5723a31b2c0399"
  },
  "rooftop-07": {
    "file": "dyn-rooftop-install-07.jpg",
    "sha256": "d931245c6925554adab531372426325d703f9328eab87ec8f112445f4ee0ab13"
  },
  "redgreen-08": {
    "file": "dyn-redgreen-roofline-uplights-08.jpg",
    "sha256": "be5cb3e039f98c78718fabfa7e73f200408869e3cba146b8426ce831aa4ede01"
  },
  "red-09": {
    "file": "dyn-red-roofline-09.jpg",
    "sha256": "7ec7992d24cda5ed0a0aa992cc3316559e1969ce503c27049c22882bf9c40f34"
  },
  "warmwhite-modern-10": {
    "file": "dyn-warmwhite-modern-white-brick-10.jpg",
    "sha256": "aa543b8267ba6307e1fe3129512254301dffaa6e20958acba18344c46d1960af"
  },
  "warmwhite-garage-11": {
    "file": "dyn-warmwhite-garage-outline-11.jpg",
    "sha256": "40317fa54d548454786bff48aaf3a2f6144af2066ce61b16ebdb70d73e54926d"
  },
  "rooftop-high-14": {
    "file": "dyn-rooftop-high-14.jpg",
    "sha256": "898f7c1fc5abe3ec0f033b963aa507f036571db0d4592a49ef2da42b6b0249fd"
  },
  "rapport-colombia-12": {
    "file": "dyn-rapport-manny-colombia-12.jpg",
    "sha256": "fc0ab82b07ce1c2f4a8bdf57791a0c6795f61e63ab2b892f03dae7df2dae2dbb"
  },
  "rapport-channel4-13": {
    "file": "dyn-rapport-manny-channel4-13.jpg",
    "sha256": "d9b29738c5c3ce664d960ddd0c1e7dbd78a35435616ebf054c278a61c9605548"
  }
}

test('portable authenticated previews retain every exact approved JPEG and explicit local override', async () => {
  const route = controlSettingsRoutes.find(r => r.path === '/dynamite/settings/photos/:photoId') as any
  assert.equal(route.requiresAuth, true)
  const original = { token: process.env.MASTRA_API_TOKEN, dir: process.env.MANNY_PHOTO_DIR, home: process.env.HOME }
  const directory = await mkdtemp(join(tmpdir(), 'manny-portable-photos-'))
  const request = async (id: string, authorization = 'Bearer offline-portability-token'): Promise<Response> => {
    const headers: Record<string, string> = {}
    return route.handler({
      req: { header: () => authorization, param: () => id },
      header: (key: string, value: string) => { headers[key.toLowerCase()] = value },
      get: () => { throw new Error('Photo preview must not access a database') },
      json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers }),
    })
  }
  try {
    process.env.MASTRA_API_TOKEN = 'offline-portability-token'
    delete process.env.MANNY_PHOTO_DIR
    process.env.HOME = directory // No Mac photo library exists in this simulated hosted home.
    assert.equal((await request(PHOTOS[0].id, '')).status, 401)
    assert.equal((await request(PHOTOS[0].id, 'Bearer wrong')).status, 401)
    assert.equal((await request('../private')).status, 404)
    assert.equal((await request('not-approved')).status, 404)
    assert.equal(Object.keys(approved).length, 12)
    assert.deepEqual([...PHOTOS, ...RAPPORT].map(p => p.id).sort(), Object.keys(approved).sort())
    for (const [id, expected] of Object.entries(approved)) {
      const response = await request(id)
      assert.equal(response.status, 200, id)
      assert.equal(response.headers.get('content-type'), 'image/jpeg')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const bytes = Buffer.from(await response.arrayBuffer())
      assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, expected.file)
    }
    const override = Buffer.from('explicit operator override fixture')
    await writeFile(join(directory, PHOTOS[0].file), override)
    process.env.MANNY_PHOTO_DIR = directory
    assert.deepEqual(Buffer.from(await (await request(PHOTOS[0].id)).arrayBuffer()), override)
    assert.equal((await request(PHOTOS[1].id)).status, 404, 'missing override file must not silently use a bundled photo')
    delete process.env.MASTRA_API_TOKEN
    assert.equal((await request(PHOTOS[0].id)).status, 401)
  } finally {
    for (const [key, value] of Object.entries({ MASTRA_API_TOKEN: original.token, MANNY_PHOTO_DIR: original.dir, HOME: original.home })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  }
})
