import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { controlPanelPage } from '../src/mastra/control-panel.ts'

test('settings, photo cards and chat photos retain same-origin cookies through a protected preview edge', async () => {
  const calls: Array<{ path: string; options: RequestInit }> = []
  const element = () => ({
    isConnected: true, hidden: true, src: '', textContent: '', scrollTop: 0, scrollHeight: 0,
    append() {}, remove() {}, querySelector() { return null },
  })
  const image = element(), note = element(), log = element()
  const context = {
    token: 'offline-app-bearer', photoGeneration: 0, photoRequests: [], photoUrls: [],
    chatGeneration: 0, chatControllers: [], chatUrls: [], state: { photos: [] },
    AbortController, setTimeout, clearTimeout, URL: { createObjectURL: () => 'blob:protected-photo' },
    document: { createElement: element, createTextNode: (text: string) => text },
    $: () => log,
    fetch: async (path: string, options: RequestInit) => {
      calls.push({ path, options })
      // Model Vercel's preview edge: app bearer alone cannot supply the SSO cookie.
      if (options.credentials !== 'same-origin') return new Response('SSO required', { status: 401 })
      return path.includes('/photos/') ? new Response(new Uint8Array([0xff, 0xd8])) : Response.json({ protectedEdgePassed: true })
    },
  }
  const names = ['request', 'loadLocalPhoto', 'chatTurn']
  const source = controlPanelPage.split('\n').filter(line => names.some(name => line.startsWith(`function ${name}(`) || line.startsWith(`async function ${name}(`))).join('\n')
  assert.equal(source.split('\n').length, 3, 'execute each actual inline fetch function')
  runInNewContext(source, context)
  const ui = context as typeof context & {
    request: (path: string, body?: object) => Promise<{ protectedEdgePassed: boolean }>
    loadLocalPhoto: (photo: { id: string }, img: ReturnType<typeof element>, note: ReturnType<typeof element>) => void
    chatTurn: (role: string, content: string, result: object) => void
  }
  assert.equal((await ui.request('')).protectedEdgePassed, true)
  assert.equal((await ui.request('/chat', { message: 'offline fixture' })).protectedEdgePassed, true)
  ui.loadLocalPhoto({ id: 'rooftop-01' }, image, note)
  ui.chatTurn('assistant', 'offline fixture', {
    photoId: 'rooftop-01', settingsVersionId: 'fixture', modelId: 'fixture', toolsUsed: [], blocked: [],
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(image.src, 'blob:protected-photo')
  assert.equal(calls.length, 4)
  for (const { path, options } of calls) {
    assert.ok(path.startsWith('/dynamite/settings'), 'requests remain same origin')
    assert.equal(options.credentials, 'same-origin')
    assert.equal((options.headers as Record<string, string>).Authorization, 'Bearer offline-app-bearer')
    assert.equal(options.cache, 'no-store')
  }
})
