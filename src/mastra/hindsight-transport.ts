import { z } from 'zod'
import type { KnowledgeTransport } from './customer-context.ts'

// API shape verified against https://api.hindsight.vectorize.io/openapi.json on 2026-10-22.
const nodeSchema: z.ZodType<{ id: string; kind: 'folder' | 'page'; name: string; children?: unknown[] }> = z.object({
  id: z.string(), kind: z.enum(['folder', 'page']), name: z.string(), children: z.array(z.unknown()).optional(),
})
export function createHindsightTransport(config: { bankId: string; apiKey: string }, fetcher: typeof fetch = fetch): KnowledgeTransport {
  if (!/^paperclip::[a-f0-9-]{36}$/.test(config.bankId) || !config.apiKey) throw new Error('bank-scoped Hindsight configuration required')
  const root = `https://api.hindsight.vectorize.io/v1/default`
  const bank = `${root}/banks/${encodeURIComponent(config.bankId)}`
  async function request(url: string, body?: unknown): Promise<unknown> {
    const response = await fetcher(url, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    })
    // Provider error bodies may contain submitted data. Report status only.
    if (!response.ok) throw new Error(`Hindsight request failed (${response.status})`)
    return response.json()
  }
  let identity: Promise<void> | undefined
  async function checkIdentity() {
    identity ??= (async () => {
      const data = z.object({ banks: z.array(z.object({ bank_id: z.string() })) }).parse(await request(`${root}/banks`))
      if (data.banks.length !== 1 || data.banks[0].bank_id !== config.bankId) throw new Error('Hindsight requires the intended bank-scoped key')
    })().catch(error => { identity = undefined; throw error })
    return identity
  }
  return {
    async listPages() {
      await checkIdentity()
      const data = z.object({ roots: z.array(z.unknown()) }).parse(await request(`${bank}/knowledge-base/tree`))
      const pages: { id: string; name: string }[] = []
      function visit(nodes: unknown[], depth = 0) {
        if (depth > 12 || pages.length > 100) throw new Error('Hindsight knowledge tree exceeds supported size')
        for (const raw of nodes) {
          const node = nodeSchema.parse(raw)
          if (node.kind === 'page') pages.push({ id: node.id, name: node.name })
          if (node.children?.length) visit(node.children, depth + 1)
        }
      }
      visit(data.roots)
      return pages
    },
    async getPage(id) {
      await checkIdentity()
      const page = z.object({ id: z.string(), name: z.string(), markdown: z.string() }).parse(await request(`${bank}/knowledge-base/pages/${encodeURIComponent(id)}`))
      return { id: page.id, name: page.name, content: page.markdown }
    },
    async recall(query) {
      await checkIdentity()
      const data = z.object({ results: z.array(z.object({ text: z.string() })) }).parse(await request(`${bank}/memories/recall`, { query, budget: 'low', max_tokens: 1024 }))
      return data.results.map(r => r.text).join('\n')
    },
    async retain(document) {
      await checkIdentity()
      const data = z.object({ success: z.literal(true), bank_id: z.literal(config.bankId), operation_id: z.string().optional().nullable() }).parse(await request(`${bank}/memories`, {
        items: [{ content: document.content, document_id: document.documentId, context: 'workflow outcome', tags: document.tags }], async: true,
      }))
      return { operationId: data.operation_id ?? undefined }
    },
  }
}
