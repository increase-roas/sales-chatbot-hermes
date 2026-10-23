-- Brings the bot's runtime tables (src/mastra/tables.ts) under migrations, matching what is live, plus two
-- lookup indexes. Idempotent: every statement is IF NOT EXISTS, so applying it to the live project changes
-- nothing that already exists except adding the indexes. Apply only with Alex's yes (Supabase T5).
create table if not exists public.sms_drafts (
  id uuid primary key default gen_random_uuid(),
  ghl_message_id text unique,
  contact_id text not null default '',
  phone text not null default '',
  inbound_text text not null,
  reply text not null,
  needs_human boolean not null default false,
  blocked text[] not null default '{}',
  deal_state text not null,
  sales_draft boolean not null default true,
  created_at timestamptz not null default now(),
  media_urls text[] not null default '{}',
  photo_ids text[] not null default '{}'
);
create index if not exists sms_drafts_phone_idx on public.sms_drafts (phone);
-- "latest draft for this phone" (test-mode ratings) and the sent-photo ledger read by phone, newest first.
create index if not exists sms_drafts_phone_created_idx on public.sms_drafts (phone, created_at desc);

create table if not exists public.sms_opt_outs (
  phone text primary key,
  contact_id text not null default '',
  reason text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.sms_grades (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.sms_drafts (id),
  grade text not null check (grade in ('approve', 'edit', 'reject')),
  edited_reply text,
  created_at timestamptz not null default now(),
  constraint sms_grades_edit_has_text check (grade <> 'edit' or (edited_reply is not null and length(btrim(edited_reply)) > 0))
);
-- Foreign keys aren't indexed automatically in Postgres.
create index if not exists sms_grades_draft_id_idx on public.sms_grades (draft_id);

-- RLS stays on (the project's event trigger enables it on new public tables); stated here so a fresh project matches.
alter table public.sms_drafts enable row level security;
alter table public.sms_opt_outs enable row level security;
alter table public.sms_grades enable row level security;
