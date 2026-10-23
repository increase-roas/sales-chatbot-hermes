import { MANNY_BASELINE } from '../src/mastra/agents/sales-agent.ts'
import { PgSettingsStore } from '../src/mastra/control-settings.ts'
// Entry point for sending ONE human-approved draft (text + its photo) through GHL.
// Refuses unless GHL_SEND_ENABLED=true (A2P 10DLC verified and Alex's yes). Never sends unapproved drafts.
// Usage: node --env-file=.env --experimental-strip-types scripts/send-approved.ts <draft_id>

import pg from 'pg'

import { sendApprovedDraft } from '../src/mastra/drafts.ts'

const draftId = process.argv[2]
if (!draftId) throw new Error('usage: send-approved.ts <draft_id>')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
const db = {
  none: async (q: string, v?: unknown[]) => { await pool.query(q, v as unknown[]) },
  any: async <T,>(q: string, v?: unknown[]) => (await pool.query(q, v as unknown[])).rows as T[],
  oneOrNone: async <T,>(q: string, v?: unknown[]) => ((await pool.query(q, v as unknown[])).rows[0] as T) ?? null,
}
try {
  console.log(JSON.stringify(await sendApprovedDraft(db, draftId, { photoSettings: (await new PgSettingsStore(db, MANNY_BASELINE).active()).settings.photos })))
} finally {
  await pool.end()
}
