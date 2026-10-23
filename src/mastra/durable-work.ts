import { ensureAppTables } from './tables.ts'

export type WorkStatus = 'pending' | 'dispatching' | 'completed' | 'uncertain' | 'cancelled'
export type WorkInput = { source_key: string; kind: string; contact_id: string; due_at: Date; payload: Record<string, unknown> }
export type WorkRow = WorkInput & { status: WorkStatus; receipt: Record<string, unknown> | null }
export interface DurableWorkStore {
  enqueue(input: WorkInput): Promise<WorkRow>
  get(key: string): Promise<WorkRow | null>
  claim(key: string): Promise<WorkRow | null>
  finish(key: string, status: WorkStatus, receipt?: Record<string, unknown> | null): Promise<WorkRow>
  defer(key: string, due: Date): Promise<WorkRow>
  due(now: Date, limit: number): Promise<WorkRow[]>
}
export type WorkSql = {
  none(query: string, values?: unknown[]): Promise<unknown>
  oneOrNone<T = Record<string, unknown>>(query: string, values?: unknown[]): Promise<T | null>
  any<T = Record<string, unknown>>(query: string, values?: unknown[]): Promise<T[]>
}

const ready = new WeakMap<WorkSql, Promise<void>>()
export function ensureDurableWorkTables(db: WorkSql): Promise<void> {
  let pending = ready.get(db)
  if (!pending) {
    pending = createDurableWorkTables(db).catch(error => { ready.delete(db); throw error })
    ready.set(db, pending)
  }
  return pending
}
async function createDurableWorkTables(db: WorkSql): Promise<void> {
  await ensureAppTables(db)
  await db.none(`CREATE TABLE IF NOT EXISTS durable_sales_work (
    source_key text PRIMARY KEY, kind text NOT NULL, contact_id text NOT NULL,
    due_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'dispatching', 'completed', 'uncertain', 'cancelled')),
    payload jsonb NOT NULL DEFAULT '{}', receipt jsonb, updated_at timestamptz NOT NULL DEFAULT now()
  )`)
  await db.none(`CREATE INDEX IF NOT EXISTS durable_sales_work_due_idx ON durable_sales_work (due_at) WHERE status = 'pending'`)
}

export class PgDurableWorkStore implements DurableWorkStore {
  private db: WorkSql
  constructor(db: WorkSql) { this.db = db }
  async enqueue(input: WorkInput): Promise<WorkRow> {
    if (!input.source_key.trim() || !input.contact_id.trim() || !Number.isFinite(input.due_at.getTime())) throw new Error('durable work requires identity and due date')
    const inserted = await this.db.oneOrNone<WorkRow>(`INSERT INTO durable_sales_work (source_key, kind, contact_id, due_at, payload)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT (source_key) DO NOTHING RETURNING *`,
    [input.source_key, input.kind, input.contact_id, input.due_at, input.payload])
    const row = inserted ?? await this.get(input.source_key)
    if (!row) throw new Error('durable work receipt unavailable')
    return row
  }
  get(key: string) { return this.db.oneOrNone<WorkRow>(`SELECT * FROM durable_sales_work WHERE source_key = $1`, [key]) }
  claim(key: string) {
    // PostgreSQL serializes contending updates; only one worker sees RETURNING.
    return this.db.oneOrNone<WorkRow>(`UPDATE durable_sales_work SET status = 'dispatching', updated_at = now()
      WHERE source_key = $1 AND status = 'pending' RETURNING *`, [key])
  }
  async finish(key: string, status: WorkStatus, receipt: Record<string, unknown> | null = null) {
    const row = await this.db.oneOrNone<WorkRow>(`UPDATE durable_sales_work SET status = $2, receipt = $3, updated_at = now()
      WHERE source_key = $1 AND status = 'dispatching' RETURNING *`, [key, status, receipt])
    if (!row) throw new Error('durable work claim lost')
    return row
  }
  async defer(key: string, due: Date) {
    const row = await this.db.oneOrNone<WorkRow>(`UPDATE durable_sales_work SET status = 'pending', due_at = $2, updated_at = now()
      WHERE source_key = $1 AND status = 'dispatching' RETURNING *`, [key, due])
    if (!row) throw new Error('durable work claim lost')
    return row
  }
  due(now: Date, limit: number) {
    return this.db.any<WorkRow>(`SELECT * FROM durable_sales_work WHERE kind = 'quote_followup'
      AND status = 'pending' AND due_at <= $1 ORDER BY due_at, source_key LIMIT $2`, [now, Math.max(1, Math.min(10, Math.trunc(limit) || 10))])
  }
  // Operator recovery only: caller must establish the dispatch worker is no longer active.
  async quarantineInterrupted(key: string) {
    return this.finish(key, 'uncertain', { reason: 'interrupted_dispatch_requires_readback' })
  }
}

// Only the adapter that knows no request left the process may use this error.
export class KnownNotSentError extends Error {}
export async function runDurableEffect(
  store: DurableWorkStore, input: WorkInput,
  dispatch: () => Promise<{ providerId: string; [key: string]: unknown }>,
): Promise<WorkRow> {
  const existing = await store.enqueue(input)
  if (existing.status !== 'pending') return existing
  const claimed = await store.claim(input.source_key)
  if (!claimed) return (await store.get(input.source_key))!
  let receipt: { providerId: string; [key: string]: unknown }
  try { receipt = await dispatch() } catch (error) {
    return store.finish(input.source_key, error instanceof KnownNotSentError ? 'pending' : 'uncertain', {
      reason: error instanceof KnownNotSentError ? 'known_not_sent' : 'provider_acknowledgement_unavailable',
    })
  }
  // A receipt write failure leaves dispatching persisted: it must never repeat the create.
  if (typeof receipt?.providerId !== 'string' || !receipt.providerId.trim()) return store.finish(input.source_key, 'uncertain', { reason: 'missing_provider_id' })
  return store.finish(input.source_key, 'completed', receipt)
}
