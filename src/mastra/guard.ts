// Reply rules live here, not in the model. The model writes the words.
// This function decides whether those words are allowed to leave as a draft.

const ASKS_IF_BOT = /\b(are you|you a|you're|youre)\b.{0,40}\b(bot|robot|ai|artificial|real person|human)\b/i
const ASKS_FOR_HUMAN =
  /\b(talk|speak)\s+to\s+(a\s+)?(real\s+)?(person|human|someone)\b|\bis this (a )?(bot|robot|ai)\b|\breal person\b/i
const CLAIMS_MACHINE = /\b(as an ai|i'm an ai|i am an ai|language model|chatbot|i'm a bot|i am a bot|artificial intelligence)\b/i
const OPT_OUT = /^(stop|stopall|unsubscribe|cancel|end|quit|dnd)[\s!.]*$/i
const PRICE = /\$\s?\d[\d,]*(?:\.\d{2})?|\b\d{2,5}\s?(?:dollars|bucks)\b/i
const DATE = /\b(january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}\/\d{1,2})\b/i

export function customerNeedsHuman(customerText: string): boolean {
  return ASKS_IF_BOT.test(customerText) || ASKS_FOR_HUMAN.test(customerText)
}

export function claimsMachine(text: string): boolean {
  return CLAIMS_MACHINE.test(text)
}

export function isOptOut(text: string): boolean {
  return OPT_OUT.test(text.trim())
}

export function containsPrice(text: string): boolean {
  return PRICE.test(text)
}

export function containsDate(text: string): boolean {
  return DATE.test(text)
}

// Alex, 2026-10-15: a dash used as punctuation reads like pasted ChatGPT text.
// Any dash character, or a hyphen touching a space, becomes a comma (dropped at a
// line's start or end, and after other punctuation); hyphenated words and number
// ranges stay. Shared cases: tests/dash-cases.json (also used by optimize-sft.py).
const DASHES = '\\u2012\\u2013\\u2014\\u2015\\u2E3A\\u2E3B\\uFE58\\uFE63\\uFF0D'

export function stripDashes(text: string): string {
  return text
    .split('\n')
    .map(line =>
      line
        .replace(new RegExp(`(\\d)\\s*[${DASHES}]\\s*(\\d)`, 'g'), '$1-$2')
        .replace(new RegExp(`^\\s*(?:[-${DASHES}]+|\\u2022)\\s*`), '')
        .replace(new RegExp(`\\s*(?:[${DASHES}]+|\\s-{1,2}|-{2,})\\s*$`), '')
        .replace(new RegExp(`\\s*(?:[${DASHES}]+|\\s-{1,2}(?=\\s)|-{2,}|(?<=\\S)-\\s|\\s-(?=\\S))\\s*`, 'g'), ', ')
        .replace(/([,.!?;:])\s*,\s*/g, '$1 ')
        .replace(/\s+([,.!?])/g, '$1')
        .replace(/^,\s*/, '')
        .trimEnd(),
    )
    .join('\n')
}

export type GuardResult = {
  reply: string
  blocked: string[]
  needsHuman: boolean
}

export function guardReply(customerText: string, draft: string, priorText = ''): GuardResult {
  const blocked: string[] = []
  let reply = draft
  const known = `${priorText}\n${customerText}`

  if (customerNeedsHuman(customerText) || claimsMachine(draft)) {
    blocked.push('identity')
    reply = "I'll have someone from the Dynamite Lights team reach out to you directly."
    return { reply: stripDashes(reply), blocked, needsHuman: true }
  }

  if (containsPrice(reply) && !containsPrice(known)) {
    blocked.push('price')
    reply = 'I can get that quoted. Could you send a photo of the front of the house and the address?'
  }

  if (containsDate(reply) && !containsDate(known)) {
    blocked.push('date')
    reply = "I don't have a date locked in yet. Once we have the address and a photo of the front, we can get you on the schedule."
  }

  const undashed = stripDashes(reply)
  if (undashed !== reply) blocked.push('dash')
  return { reply: undashed, blocked, needsHuman: false }
}
