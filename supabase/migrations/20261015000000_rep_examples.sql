-- Real rep replies from closed deals, searchable by the customer message they answered.
-- The sales agent looks up the closest past moments and drafts in the reps' style.
-- 4096-dim qwen3-embedding-8b vectors exceed pgvector's 2000-dim index limit, so search is exact.
-- A few thousand rows scan in milliseconds; revisit (halfvec or a smaller embedder) past ~50k rows.
-- RLS turns on automatically (private.enable_rls_on_new_public_tables); only the server owner connection reads it.

create table if not exists public.rep_examples (
  id bigint generated always as identity primary key,
  example_key text not null unique,
  contact_id text not null,
  customer_text text not null,
  rep_text text not null,
  customer_label text not null,
  rep_label text not null,
  channel text not null default 'text',
  source text not null,
  embedding extensions.vector(4096) not null,
  created_at timestamptz not null default now()
);

create index if not exists rep_examples_customer_label_idx on public.rep_examples (customer_label);
