// Load labeled rep replies into Supabase and look up examples for an eval set.
//
// Usage:
//   node --env-file=.env --experimental-strip-types scripts/rep-examples.ts load <labeled.jsonl> <holdout.map.jsonl>
//   node --env-file=.env --experimental-strip-types scripts/rep-examples.ts lookup <holdout.jsonl> <out.json> [k]
//
// load skips every holdout contact so the eval never sees its own answers, and drops off-topic services.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { PostgresStore } from '@mastra/pg'

import { embed, examplesBlock, similarRepExamples, vectorLiteral } from '../src/mastra/rep-examples.ts'

const OFF_TOPIC = /halloween|window clean|gutter|power ?wash|pressure ?wash|garbage|trash|\bbins?\b|can cleaning|landscap/i
const SOURCE = 'closed-deals-v2-2026-10-14'
const BATCH = 16

type Labeled = {
  contact_id: string
  ts: string
  channel: string
  customer: string
  rep: string
  customer_label: string
  rep_label: string
}

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}
const store = new PostgresStore({ id: 'rep-examples', connectionString: databaseUrl, max: 2 })
const db = store.db

function jsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T)
}

async function load(labeledPath: string, holdoutMapPath: string): Promise<void> {
  const holdout = new Set(jsonl<{ contact_id: string }>(holdoutMapPath).map(row => row.contact_id))
  const all = jsonl<Labeled>(labeledPath)
  const rows = all.filter(
    row =>
      !holdout.has(row.contact_id) &&
      row.customer.trim() &&
      row.rep.trim() &&
      !OFF_TOPIC.test(row.customer) &&
      !OFF_TOPIC.test(row.rep),
  )
  let loaded = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const vectors = await embed(batch.map(row => row.customer.slice(-400)))
    for (const [j, row] of batch.entries()) {
      const key = createHash('sha256').update(`${row.contact_id}|${row.ts}|${row.rep}`).digest('hex')
      await db.none(
        `INSERT INTO rep_examples
           (example_key, contact_id, customer_text, rep_text, customer_label, rep_label, channel, source, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::extensions.vector)
         ON CONFLICT (example_key) DO NOTHING`,
        [key, row.contact_id, row.customer.slice(-400), row.rep, row.customer_label, row.rep_label, row.channel, SOURCE, vectorLiteral(vectors[j])],
      )
    }
    loaded += batch.length
  }
  console.log(JSON.stringify({ labeled: all.length, skipped_holdout_or_off_topic: all.length - rows.length, loaded }))
}

async function lookup(holdoutPath: string, outPath: string, k: number): Promise<void> {
  const rows = jsonl<{ messages: Array<{ role: string; content: string }> }>(holdoutPath)
  const out: Record<number, string> = {}
  for (const [i, row] of rows.entries()) {
    const lastCustomer = [...row.messages.slice(0, -1)].reverse().find(m => m.role === 'user')?.content ?? ''
    out[i] = lastCustomer ? examplesBlock(await similarRepExamples(db, lastCustomer, k)) : ''
  }
  writeFileSync(outPath, JSON.stringify(out, null, 1))
  console.log(JSON.stringify({ rows: rows.length, with_examples: Object.values(out).filter(Boolean).length, out: outPath }))
}

const [cmd, a, b, c] = process.argv.slice(2)
try {
  if (cmd === 'load') await load(a, b)
  else if (cmd === 'lookup') await lookup(a, b, Number(c ?? 5))
  else throw new Error('usage: load <labeled.jsonl> <holdout.map.jsonl> | lookup <holdout.jsonl> <out.json> [k]')
} finally {
  await store.close()
}
