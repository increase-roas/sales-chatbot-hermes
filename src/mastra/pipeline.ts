import { createHash } from 'node:crypto'

// Pure helpers for scripts/pipeline-push.ts (tested in tests/pipeline.test.ts).
export type Opp = { id: string; contactId: string; stageId: string; status: string }

// Page through every open opportunity; stop on a short page or a repeat page.
export async function allOpportunities(fetchPage: (page: number) => Promise<Opp[]>, pageSize: number, maxPages = 50): Promise<Opp[]> {
  const out: Opp[] = []
  const seenFirst = new Set<string>()
  for (let page = 1; page <= maxPages; page++) {
    const rows = await fetchPage(page)
    if (!rows.length || seenFirst.has(rows[0].id)) break
    seenFirst.add(rows[0].id)
    out.push(...rows)
    if (rows.length < pageSize) break
  }
  return out
}

// One draft per contact even if they sit in two opportunities.
export function dedupeByContact(opps: Opp[]): Opp[] {
  const seen = new Set<string>()
  return opps.filter(o => o.contactId && !seen.has(o.contactId) && Boolean(seen.add(o.contactId)))
}

export function batchSha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

// Alex approves a specific batch: his words plus the first 12+ characters of its sha256, shown at draft time.
export function approvalMatches(batchText: string, approvedSha: string): boolean {
  const sha = batchSha256(batchText)
  return approvedSha.trim().length >= 12 && sha.startsWith(approvedSha.trim().toLowerCase())
}
