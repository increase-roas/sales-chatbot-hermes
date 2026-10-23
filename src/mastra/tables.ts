// App tables, created through the same Postgres connection Mastra uses.
// The Supabase event trigger turns on row-level security. The owner connection still reads and writes.

type Sql = {
  none(query: string, values?: unknown[]): Promise<unknown>
}

const ready = new WeakMap<Sql, Promise<void>>()

export function ensureAppTables(db: Sql): Promise<void> {
  let pending = ready.get(db)
  if (!pending) {
    pending = createAppTables(db).catch(error => { ready.delete(db); throw error })
    ready.set(db, pending)
  }
  return pending
}

async function createAppTables(db: Sql): Promise<void> {
  await db.none(`CREATE TABLE IF NOT EXISTS sms_conversation_control (
    contact_id text PRIMARY KEY,
    owner text NOT NULL DEFAULT 'bot' CHECK (owner IN ('human', 'bot')),
    stopped boolean NOT NULL DEFAULT false,
    identity_hold boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`)
  await db.none(`CREATE TABLE IF NOT EXISTS sms_phone_aliases (
    phone text PRIMARY KEY,
    contact_id text NOT NULL REFERENCES sms_conversation_control(contact_id),
    created_at timestamptz NOT NULL DEFAULT now()
  )`)
  await db.none(`
    CREATE TABLE IF NOT EXISTS sms_drafts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ghl_message_id text UNIQUE,
      contact_id text NOT NULL DEFAULT '',
      phone text NOT NULL DEFAULT '',
      inbound_text text NOT NULL,
      reply text NOT NULL,
      needs_human boolean NOT NULL DEFAULT false,
      blocked text[] NOT NULL DEFAULT '{}',
      deal_state text NOT NULL,
      sales_draft boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.none(`CREATE INDEX IF NOT EXISTS sms_drafts_phone_idx ON sms_drafts (phone)`)
  await db.none(`CREATE INDEX IF NOT EXISTS sms_drafts_phone_created_idx ON sms_drafts (phone, created_at DESC)`)
  await db.none(`ALTER TABLE sms_drafts ADD COLUMN IF NOT EXISTS completion_intent jsonb`)
  // Photo attachments (at most one per draft). Additive: old rows read as no media.
  await db.none(`ALTER TABLE sms_drafts ADD COLUMN IF NOT EXISTS media_urls text[] NOT NULL DEFAULT '{}'`)
  await db.none(`ALTER TABLE sms_drafts ADD COLUMN IF NOT EXISTS photo_ids text[] NOT NULL DEFAULT '{}'`)
  await db.none(`
    CREATE TABLE IF NOT EXISTS sms_opt_outs (
      phone text PRIMARY KEY,
      contact_id text NOT NULL DEFAULT '',
      reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.none(`
    CREATE TABLE IF NOT EXISTS sms_grades (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      draft_id uuid NOT NULL REFERENCES sms_drafts (id),
      grade text NOT NULL CHECK (grade IN ('approve', 'edit', 'reject')),
      edited_reply text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT sms_grades_edit_has_text CHECK (
        grade <> 'edit' OR (edited_reply IS NOT NULL AND length(btrim(edited_reply)) > 0)
      )
    )
  `)
  await db.none(`CREATE INDEX IF NOT EXISTS sms_grades_draft_id_idx ON sms_grades (draft_id)`)
}
