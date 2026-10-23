import { PostgresStore } from '@mastra/pg'

import { ensureAppTables } from '../src/mastra/tables.ts'

// Reads grades a person already saved. Does not invent grades and does not train.
// Calibration against a judge waits until about 100 human grades exist.
// Laya is not verified on Orgo, so this script does not call it.

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

const store = new PostgresStore({ id: 'grade-export', connectionString: databaseUrl })
await ensureAppTables(store.db)

const rows = await store.db.any<{
  grade: string
  inbound_text: string
  reply: string
  edited_reply: string | null
}>(
  `SELECT sms_grades.grade, sms_drafts.inbound_text, sms_drafts.reply, sms_grades.edited_reply
   FROM sms_grades
   JOIN sms_drafts ON sms_drafts.id = sms_grades.draft_id
   ORDER BY sms_grades.created_at ASC`,
)

const sft = rows
  .filter(row => row.grade === 'approve')
  .map(row => ({
    messages: [
      { role: 'user', content: row.inbound_text },
      { role: 'assistant', content: row.reply },
    ],
  }))

const dpo = rows
  .filter(row => row.grade === 'edit' || row.grade === 'reject')
  .filter(row => row.edited_reply && row.edited_reply.trim() && row.edited_reply.trim() !== row.reply)
  .map(row => ({
    input: { messages: [{ role: 'user', content: row.inbound_text }] },
    preferred_output: [{ role: 'assistant', content: row.edited_reply }],
    non_preferred_output: [{ role: 'assistant', content: row.reply }],
  }))

const rejectsWithoutRewrite = rows.filter(row => row.grade === 'reject' && !row.edited_reply?.trim()).length

console.log(
  JSON.stringify(
    {
      grades: rows.length,
      sftRows: sft.length,
      dpoPairs: dpo.length,
      rejectsWithoutRewrite,
      note:
        rows.length < 100
          ? 'Calibration waits for about 100 human grades. Laya is not verified on Orgo. No training was run.'
          : 'About 100 human grades are on file. No training was run from this export.',
      sft,
      dpo,
    },
    null,
    2,
  ),
)

await store.close()
