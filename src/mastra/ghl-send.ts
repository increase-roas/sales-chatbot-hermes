import { ghlSmsPayload, limitMedia } from './photos.ts'

// Sends one approved draft (text + at most one photo) through GHL "Send a new message".
// Off unless explicitly enabled: live SMS needs A2P 10DLC and Alex's yes. Tests point baseUrl at a
// local server to prove the exact request without touching GHL.
export type SendInput = { contactId: string; reply: string; mediaUrls: string[] }
export type SendOptions = {
  enabled?: boolean
  apiKey?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}
export type SendResult = { sent: boolean; status?: number; messageId?: string; reason?: string }

export const GHL_BASE_URL = 'https://services.leadconnectorhq.com'
export const GHL_VERSION = '2021-04-15'

export async function sendDraftToGhl(input: SendInput, opts: SendOptions = {}): Promise<SendResult> {
  const enabled = opts.enabled ?? process.env.GHL_SEND_ENABLED === 'true'
  if (!enabled) return { sent: false, reason: 'sending is off (GHL_SEND_ENABLED is not true)' }
  const apiKey = opts.apiKey ?? process.env.GHL_API_KEY ?? ''
  if (!apiKey) return { sent: false, reason: 'GHL_API_KEY is not set' }
  if (!input.contactId || !input.reply.trim()) return { sent: false, reason: 'contactId and reply are required' }
  const body = ghlSmsPayload(input.contactId, input.reply, limitMedia(input.mediaUrls))
  const response = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl ?? GHL_BASE_URL}/conversations/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, Version: GHL_VERSION, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const json = (await response.json().catch(() => ({}))) as { messageId?: string }
  return response.ok ? { sent: true, status: response.status, messageId: json.messageId } : { sent: false, status: response.status, reason: 'GHL rejected the message' }
}
