export function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n')
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  const chunks: string[] = []
  if (typeof record.text === 'string') chunks.push(record.text)
  if (typeof record.content === 'string') chunks.push(record.content)
  else if (record.content && typeof record.content === 'object') chunks.push(textOf(record.content))
  if (Array.isArray(record.parts)) chunks.push(textOf(record.parts))
  return [...new Set(chunks.map(chunk => chunk.trim()).filter(Boolean))].join('\n')
}

export function roleOf(value: unknown): string {
  if (!value || typeof value !== 'object' || !('role' in value)) return ''
  const role = (value as { role?: unknown }).role
  return typeof role === 'string' ? role : ''
}

// Rep lines are the only place a stated price counts as an estimate.
// System text is dropped so the prompt's own words are not treated as the customer's.
export function threadLine(message: unknown): string {
  const role = roleOf(message)
  if (role === 'system' || role === 'signal') return ''
  const text = textOf(message).trim()
  if (!text) return ''
  if (role === 'assistant') return `Rep: ${text}`
  if (role === 'user') return `Customer: ${text}`
  return text
}
