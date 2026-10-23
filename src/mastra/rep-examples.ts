// Past rep replies from closed deals, searched by the customer message they answered.
// Table: supabase/migrations/20261015000000_rep_examples.sql. Exact cosine search (4096 dims, no index).

const EMBED_URL = 'https://api.fireworks.ai/inference/v1/embeddings'
const EMBED_MODEL = 'accounts/fireworks/models/qwen3-embedding-8b'

type Sql = {
  none(query: string, values?: unknown[]): Promise<unknown>
  any<T = Record<string, unknown>>(query: string, values?: unknown[]): Promise<T[]>
}

export type RepExample = {
  customer_text: string
  rep_text: string
  customer_label: string
  rep_label: string
  distance: number
}

export async function embed(texts: string[]): Promise<number[][]> {
  const key = process.env.FIREWORKS_API_KEY
  if (!key) throw new Error('FIREWORKS_API_KEY is not set')
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(EMBED_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
      signal: AbortSignal.timeout(60_000),
    })
    if (response.ok) {
      const body = (await response.json()) as { data: Array<{ index: number; embedding: number[] }> }
      return body.data.sort((a, b) => a.index - b.index).map(item => item.embedding)
    }
    if (![429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error(`embedding failed: HTTP ${response.status}`)
    }
    await new Promise(resolve => setTimeout(resolve, 2 ** attempt * 2000))
  }
  throw new Error('embedding failed: retries exhausted')
}

export function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`
}

export async function similarRepExamples(db: Sql, customerText: string, limit = 5): Promise<RepExample[]> {
  const [vector] = await embed([customerText.slice(-400)])
  return db.any<RepExample>(
    `SELECT customer_text, rep_text, customer_label, rep_label,
            embedding OPERATOR(extensions.<=>) $1::extensions.vector AS distance
     FROM rep_examples
     ORDER BY distance
     LIMIT $2`,
    [vectorLiteral(vector), limit],
  )
}

// Prompt block for the agent. Examples show style and moves; they are never a source of prices or dates.
export function examplesBlock(examples: RepExample[]): string {
  if (!examples.length) return ''
  const lines = examples.map((ex, i) => `${i + 1}. CUSTOMER: ${ex.customer_text.trim()}\n   REP: ${ex.rep_text.trim()}`)
  return [
    'Here is what Dynamite reps actually texted in similar moments with customers who went on to buy.',
    'Match their length, tone, and next move. Do not copy names, prices, dates, or details that are not in this thread.',
    '',
    ...lines,
  ].join('\n')
}
