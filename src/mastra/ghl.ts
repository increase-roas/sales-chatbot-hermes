// Minimal GHL client for the sales flow (contact tags, Marvin's task, pipeline reads).
// Runtime route: the Dynamite "Sales — Full Access" private integration token as GHL_API_KEY (1Password item
// "Dynamite Lights - operator - Sales, CSM & Dispatch Jobber + GHL"). Writes only happen through enabled flows.
import type { CallRecord } from './conversation-rules.ts'

export const GHL_URL = 'https://services.leadconnectorhq.com'
export const DYNAMITE_LOCATION_ID = 'AgYU7eDD6q7eXj6RUven'
export const MARVIN_USER_ID = 'HpFTUi2DSsNfeAA5G12m'
export const QUOTE_REQUESTED_TAG = 'quote requested'

export type GhlThreadMessage = { role: 'user' | 'assistant'; text: string; at: string; id?: string; channel?: string; direction?: string }

export type GhlClient = {
  getContact(contactId: string): Promise<{ id: string; tags: string[]; name: string; phone: string; email: string; address: string }>
  addTags(contactId: string, tags: string[]): Promise<void>
  createTask(contactId: string, task: { title: string; body: string; assignedTo: string; dueDate: string }): Promise<{ id: string }>
  searchOpportunities(pipelineId: string, limit?: number, page?: number): Promise<Array<{ id: string; contactId: string; stageId: string; status: string }>>
  getThread(contactId: string, limit?: number): Promise<GhlThreadMessage[]>
  getCalls(contactId: string, limit?: number): Promise<CallRecord[]>
}

export function ghlClient(key = process.env.GHL_API_KEY ?? '', base = GHL_URL, fetchImpl: typeof fetch = fetch): GhlClient | null {
  if (!key) return null
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, Version: '2021-07-28', Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`ghl ${method} ${path.split('?')[0]} ${response.status}`)
    return (await response.json().catch(() => ({}))) as T
  }
  return {
    async getContact(contactId) {
      const { contact } = await call<{ contact: Record<string, unknown> }>('GET', `/contacts/${contactId}`)
      const s = (k: string) => (typeof contact?.[k] === 'string' ? (contact[k] as string) : '')
      return {
        id: s('id'),
        tags: Array.isArray(contact?.tags) ? (contact.tags as string[]) : [],
        name: [s('firstName'), s('lastName')].filter(Boolean).join(' ') || s('contactName'),
        phone: s('phone'),
        email: s('email'),
        address: [s('address1'), s('city'), s('state'), s('postalCode')].filter(Boolean).join(', '),
      }
    },
    async addTags(contactId, tags) {
      await call('POST', `/contacts/${contactId}/tags`, { tags })
    },
    async createTask(contactId, task) {
      const out = await call<{ task?: { id?: string } }>('POST', `/contacts/${contactId}/tasks`, { ...task, completed: false })
      return { id: out.task?.id ?? '' }
    },
    async searchOpportunities(pipelineId, limit = 100, page = 1) {
      const out = await call<{ opportunities?: Array<Record<string, string>> }>(
        'GET',
        `/opportunities/search?location_id=${DYNAMITE_LOCATION_ID}&pipeline_id=${pipelineId}&status=open&limit=${limit}&page=${page}`,
      )
      return (out.opportunities ?? []).map(o => ({ id: o.id, contactId: o.contactId, stageId: o.pipelineStageId, status: o.status }))
    },
    async getThread(contactId, limit = 40) {
      const conv = await call<{ conversations?: Array<{ id: string }> }>('GET', `/conversations/search?locationId=${DYNAMITE_LOCATION_ID}&contactId=${contactId}&limit=1`)
      const id = conv.conversations?.[0]?.id
      if (!id) return []
      const out = await call<{ messages?: { messages?: Array<Record<string, string>> } }>('GET', `/conversations/${id}/messages?limit=${limit}`)
      return (out.messages?.messages ?? [])
        .filter(m => /SMS|FACEBOOK|IG/i.test(m.messageType ?? 'SMS'))
        // An attachment-only inbound is still a customer reply. Preserve its metadata
        // and empty text rather than inventing conversational content.
        .map(m => ({ id: m.id, role: m.direction === 'inbound' ? ('user' as const) : ('assistant' as const), text: m.body ?? '', at: m.dateAdded, channel: m.messageType ?? 'SMS', direction: m.direction }))
        .sort((a, b) => a.at.localeCompare(b.at))
    },
    // Calls are TYPE_CALL messages in the same conversation. UNVERIFIED: meta.call field names and the
    // transcription path; any failure just means "no call context" (the hold check then sees no calls).
    async getCalls(contactId, limit = 40) {
      const conv = await call<{ conversations?: Array<{ id: string }> }>('GET', `/conversations/search?locationId=${DYNAMITE_LOCATION_ID}&contactId=${contactId}&limit=1`)
      const id = conv.conversations?.[0]?.id
      if (!id) return []
      const out = await call<{ messages?: { messages?: Array<Record<string, unknown>> } }>('GET', `/conversations/${id}/messages?limit=${limit}`)
      const calls = (out.messages?.messages ?? []).filter(m => /CALL/i.test(String(m.messageType ?? '')))
      return Promise.all(calls.map(async m => {
        const meta = (m.meta as { call?: { status?: string; duration?: number } } | undefined)?.call ?? {}
        let transcript = ''
        try {
          const t = await call<Array<{ transcript?: string }> | { transcript?: string }>('GET', `/conversations/locations/${DYNAMITE_LOCATION_ID}/messages/${String(m.id)}/transcription`)
          transcript = (Array.isArray(t) ? t.map(x => x.transcript ?? '').join(' ') : t.transcript ?? '').trim()
        } catch {
          transcript = ''
        }
        return { id: String(m.id ?? ''), at: String(m.dateAdded ?? ''), status: String(meta.status ?? m.status ?? ''), direction: String(m.direction ?? ''), durationSec: Number(meta.duration ?? 0), transcript }
      }))
    },
  }
}
