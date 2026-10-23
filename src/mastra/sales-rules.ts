// Alex's 2026-10-15 sales rules, enforced in code after the model writes.
// Goal: a YES to a holiday-lights quote (rooflines first), then the address. No wreaths this season.
// Never ask the lead for a photo unless they say our mockup is wrong.

const WREATH = /\bwreaths?\b|\bgarlands?\b/i
// A decline must govern the wreath directly ("no wreaths", "not doing wreaths"), not just sit nearby.
const WREATH_DECLINE = /\b(?:no|not doing|aren'?t doing|arent doing|don'?t do|dont do|skip(?:ping)?|not offering)\s+(?:any\s+)?(?:wreaths?|garlands?)\b/i
const WREATH_OFFER_CUE = /\b(want|add|include|throw in|upgrade|how about|also do|can do|we do)\b[^.?!]{0,30}\b(wreaths?|garlands?)\b|\b(wreaths?|garlands?)\b[^.?!]{0,30}\?/i
const PHOTO_WORD = '(?:photos?|pics?|pictures?|images?|shots?|snapshots?|selfies? of (?:the|your) house)'
const PHOTO_ASK = new RegExp(
  `\\b(?:send|shoot|text|snap|grab|share|attach|upload|take|mind sending|need)\\b[^.?!]{0,40}\\b${PHOTO_WORD}\\b|\\b${PHOTO_WORD}\\b[^.?!]{0,30}\\bof (?:the |your )?(?:front|house|home|place|roof)\\b`,
  'i',
)
const YES = /\b(yes|yep|yeah|sure|ok(?:ay)?|let'?s do it|sounds good|go ahead|i want (?:a|the) quote)\b/i
const ASKS_ADDRESS = /\baddress\b/i
const MOCKUP_WRONG = /\bmock ?-?up\b[^.?!]{0,40}\b(wrong|off|incorrect|not right|isn'?t right|not my|different)\b|\b(wrong|not my) house\b/i
const APPROVED_STAGE = /approved quote|sold|said yes/i

export const NO_WREATH_LINE = "we're all about rooflines this year, no wreaths this season."
export const ADDRESS_ASK = "what's the address? we'll put a mockup and quote together for you."

// Past the quote: the CUSTOMER says they paid, put the deposit down or approved. Questions, negations and rep
// lines never count (Codex r2). The address is then on file, and the bot must not restart the quote pitch.
const PAST_QUOTE = /\b(?:i|we)(?:'ve| have| just| already)*\s+(?:paid|approved|signed|accepted|put (?:the |a )?deposit)|\b(?:deposit|payment) (?:is |was )?(?:sent|paid|done|down|made)\b|\balready (?:booked|approved|paid)\b/i
const NEGATED = /\b(?:not|never|haven'?t|didn'?t|no)\b|n't\b/i
const CONDITIONAL = /\b(?:if|would|could|should|will|when|once|before|suppose|supposing|imagine|hypothetically|say|can i|do i|do you)\b/i

// Judged per clause (Codex r3): "I paid the deposit. When can you install?" counts; "if I paid a deposit
// today that would secure it" and questions don't.
export function pastQuote(threadText: string): boolean {
  return threadText.split('\n').some(line => {
    if (/^rep:/i.test(line.trim())) return false
    const text = line.replace(/^customer:\s*/i, '')
    return (text.match(/[^.!?,;]+[.!?,;]*/g) ?? []).some(sentence =>
      PAST_QUOTE.test(sentence) && !sentence.includes('?') && !NEGATED.test(sentence) && !CONDITIONAL.test(sentence))
  })
}

export function offersWreath(reply: string): boolean {
  if (!WREATH.test(reply)) return false
  if (WREATH_DECLINE.test(reply) && !WREATH_OFFER_CUE.test(reply.replace(WREATH_DECLINE, ''))) return false
  return true
}

export function asksForPhoto(reply: string): boolean {
  return PHOTO_ASK.test(reply)
}

export function mockupDisputed(customerText: string): boolean {
  return MOCKUP_WRONG.test(customerText)
}

export type SalesRuleResult = { reply: string; blocked: string[] }

// Rewrites a draft that breaks the rules. Address-first: if we don't have it, the fallback asks for it.
export function applySalesRules(customerText: string, draft: string, addressKnown: boolean, postQuote = false): SalesRuleResult {
  const blocked: string[] = []
  let reply = draft
  if (postQuote) {
    // Already bought: keep the season's limits but never restart the quote pitch.
    if (offersWreath(reply)) {
      blocked.push('wreath')
      reply = capital(NO_WREATH_LINE)
    }
    if (asksForPhoto(reply) && !mockupDisputed(customerText)) {
      blocked.push('photo_request')
      reply = "got it, you're all set! anything else you need from us?"
    }
    return { reply, blocked }
  }
  if (offersWreath(reply)) {
    blocked.push('wreath')
    reply = addressKnown ? `${capital(NO_WREATH_LINE)} want me to get the roofline quote going?` : `${capital(NO_WREATH_LINE)} ${ADDRESS_ASK}`
  }
  if (asksForPhoto(reply) && !mockupDisputed(customerText)) {
    blocked.push('photo_request')
    reply = addressKnown ? "perfect, we'll put your mockup together and send it over with the quote." : capital(ADDRESS_ASK)
  }
  if (!addressKnown && YES.test(customerText) && !ASKS_ADDRESS.test(reply)) {
    blocked.push('address_missing')
    reply = `${reply.trim()} ${ADDRESS_ASK}`.trim()
  }
  return { reply, blocked }
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// Hard stop (Alex 2026-10-15): once a Jobber quote is approved the bot never texts that contact again.
// Any one signal stops it; an unknown Jobber status also stops it (fail closed).
export type QuoteSignals = {
  jobberStatus: 'approved' | 'converted' | 'sent' | 'draft' | 'none' | 'unknown'
  tags?: string[]
  stageName?: string
}

// failClosed: true before any SEND (unknown Jobber status stops it); drafts use false (only known stops).
export function quoteApprovedStop(signals: QuoteSignals, failClosed = true): { stop: boolean; reason: string } {
  if (signals.jobberStatus === 'approved' || signals.jobberStatus === 'converted') return { stop: true, reason: 'jobber_quote_approved' }
  if ((signals.tags ?? []).some(t => /^approved lights 2026$|^do_not_bot$|^bot_paused$/i.test(t.trim()))) return { stop: true, reason: 'tag_stop' }
  if (signals.stageName && APPROVED_STAGE.test(signals.stageName)) return { stop: true, reason: 'pipeline_stage_approved' }
  if (failClosed && signals.jobberStatus === 'unknown') return { stop: true, reason: 'jobber_status_unknown' }
  return { stop: false, reason: '' }
}
