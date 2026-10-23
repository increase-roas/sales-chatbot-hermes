import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

const GHL_BASE = 'https://services.leadconnectorhq.com'
const EMPTY_NOTES_MISSING = 'GHL credentials are not configured. No contact was looked up.'

const opportunitySchema = z.object({
  id: z.string(),
  name: z.string(),
  stage: z.string(),
  status: z.string(),
})

const empty = {
  found: false,
  name: '',
  stage: '',
  notes: [] as string[],
  opportunities: [] as Array<z.infer<typeof opportunitySchema>>,
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function contactName(contact: Record<string, unknown>): string {
  const combined = [text(contact.firstName) || text(contact.first_name), text(contact.lastName) || text(contact.last_name)]
    .filter(Boolean)
    .join(' ')
  return combined || text(contact.contactName) || text(contact.name)
}

async function ghlGet(path: string, key: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(`${GHL_BASE}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      Version: '2021-07-28',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(8000),
  })
  const body = await response.json().catch(() => null)
  return { ok: response.ok, status: response.status, body }
}

function contactFrom(body: unknown): Record<string, unknown> | null {
  const root = record(body)
  if (!root) return null
  const direct = record(root.contact)
  if (direct && (text(direct.id) || contactName(direct))) return direct
  const list = Array.isArray(root.contacts) ? root.contacts : []
  const first = record(list[0])
  return first
}

export const lookupProspect = createTool({
  id: 'lookup-prospect',
  description: "Read a prospect's GoHighLevel contact and opportunity. Returns an empty result when lookup is unavailable. Does not write to GoHighLevel.",
  inputSchema: z.object({
    phone: z.string().describe("Prospect's phone number, e.g. +15551234567"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    name: z.string(),
    stage: z.string(),
    notes: z.array(z.string()),
    opportunities: z.array(opportunitySchema),
  }),
  execute: async ({ phone }) => {
    const key = process.env.GHL_API_KEY
    const locationId = process.env.GHL_LOCATION_ID
    if (!key || !locationId) return { ...empty, notes: [EMPTY_NOTES_MISSING] }
    const number = phone.trim()
    if (!number) return { ...empty, notes: ['A phone number is required.'] }

    try {
      const encodedLocation = encodeURIComponent(locationId)
      const encodedNumber = encodeURIComponent(number)
      const duplicate = await ghlGet(
        `/contacts/search/duplicate?locationId=${encodedLocation}&number=${encodedNumber}`,
        key,
      )
      let contact = duplicate.ok ? contactFrom(duplicate.body) : null
      if (!contact) {
        const search = await ghlGet(`/contacts/?locationId=${encodedLocation}&query=${encodedNumber}`, key)
        if (!search.ok && !duplicate.ok) {
          return { ...empty, notes: ['GHL lookup failed. No contact data was returned.'] }
        }
        contact = contactFrom(search.body)
      }
      if (!contact) return { ...empty, notes: ['No matching GoHighLevel contact.'] }

      const contactId = text(contact.id)
      let opportunities: Array<z.infer<typeof opportunitySchema>> = []
      if (contactId) {
        const found = await ghlGet(
          `/opportunities/search?location_id=${encodedLocation}&contact_id=${encodeURIComponent(contactId)}`,
          key,
        )
        const root = record(found.body)
        const list = Array.isArray(root?.opportunities) ? root.opportunities : []
        opportunities = list.slice(0, 10).map(item => {
          const row = record(item) ?? {}
          return {
            id: text(row.id),
            name: text(row.name),
            stage: text(row.pipelineStageId) || text(row.pipelineStageName) || text(row.stage),
            status: text(row.status),
          }
        })
      }

      const stage = opportunities.find(item => item.status)?.status || opportunities[0]?.stage || ''
      return {
        found: true,
        name: contactName(contact),
        stage,
        notes: [],
        opportunities,
      }
    } catch {
      return { ...empty, notes: ['GHL lookup failed. No contact data was returned.'] }
    }
  },
})
