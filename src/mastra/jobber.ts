// Jobber quote status for the hard stop, plus quote creation for the quote-requested flow.
// UNVERIFIED: field names (clients searchTerm, quotes.quoteStatus, jobberWebUri) and the version header are
// from memory; Jobber's docs need a developer login. Introspect in the bot's GraphiQL before enabling.
// Any error or unexpected shape returns "unknown", which stops the bot (fail closed).
// Jobber's API is GraphQL (https://developer.getjobber.com/docs). Auth: a Jobber OAuth access token for a
// grant made for this bot (JOBBER_ACCESS_TOKEN). The existing dispatch-sync app's token must NOT be reused:
// it rotates and lives in that app's server store.
import type { QuoteSignals } from './sales-rules.ts'

export const JOBBER_URL = 'https://api.getjobber.com/api/graphql'
export const JOBBER_VERSION = '2025-04-16'

export type JobberClient = {
  quoteStatusForPhone(phone: string): Promise<QuoteSignals['jobberStatus']>
  createQuote(input: { name: string; phone: string; email?: string; address: string; note: string }): Promise<{ id: string; url: string }>
}

type Gql = (query: string, variables: Record<string, unknown>) => Promise<Record<string, unknown>>

export function graphqlFetcher(token = process.env.JOBBER_ACCESS_TOKEN ?? '', url = JOBBER_URL, fetchImpl: typeof fetch = fetch): Gql | null {
  if (!token) return null
  return async (query, variables) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-JOBBER-GRAPHQL-VERSION': JOBBER_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await response.json()) as { data?: Record<string, unknown>; errors?: unknown }
    if (!response.ok || body.errors) throw new Error(`jobber ${response.status}`)
    return body.data ?? {}
  }
}

const QUOTES_BY_PHONE = `query QuotesByPhone($term: String!) {
  clients(searchTerm: $term, first: 5) { nodes { id quotes(first: 20) { nodes { id quoteStatus jobberWebUri } } } }
}`

const RANK: Record<string, number> = { approved: 5, converted: 5, awaiting_response: 3, changes_requested: 3, draft: 2, archived: 1 }

export function jobberClient(gql: Gql | null): JobberClient {
  return {
    async quoteStatusForPhone(phone) {
      if (!gql || !phone) return 'unknown'
      try {
        const data = (await gql(QUOTES_BY_PHONE, { term: phone.replace(/\D/g, '').slice(-10) })) as {
          clients?: { nodes?: Array<{ quotes?: { nodes?: Array<{ quoteStatus?: string }> } }> }
        }
        if (!data || !data.clients || !Array.isArray(data.clients.nodes)) return 'unknown'
        const statuses = data.clients.nodes.flatMap(c => c.quotes?.nodes ?? []).map(q => (q.quoteStatus ?? '').toLowerCase())
        if (!statuses.length) return 'none'
        // Any status we don't recognize makes the answer unknown (fail closed), never "not approved".
        if (statuses.some(st => !(st in RANK))) return 'unknown'
        const best = statuses.sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0))[0]
        if (best === 'approved') return 'approved'
        if (best === 'converted') return 'converted'
        if (best === 'awaiting_response' || best === 'changes_requested') return 'sent'
        return 'draft'
      } catch {
        return 'unknown'
      }
    },
    async createQuote() {
      // Needs Alex's yes and a confirmed Jobber input schema (clientCreate + propertyCreate + quoteCreate);
      // kept unimplemented so nothing writes to live Jobber by accident.
      throw new Error('jobber quote creation is not enabled: needs the bot Jobber grant and Alex approval')
    },
  }
}
