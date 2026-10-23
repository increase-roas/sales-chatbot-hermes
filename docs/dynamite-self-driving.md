# Dynamite customer-team adapter: operating and activation runbook

Status as of 2026-10-22: development implementation, **not live-ready**. The operating standard is durable workflow execution: persisted identity, owned work, receipts, and no blind replay of ambiguous effects.

## What exists and what remains

Manny stays the existing Mastra sales agent. The active saved version selects the exact Fireworks inference ID; the initial baseline honors `FIREWORKS_SALES_MODEL`. An explicit selection never silently falls back. Alex's exact last personally used model is still unverified; the preserved code default is `fireworks-ai/accounts/fireworks/models/qwen3p8-2p4t-a95b`. Installation photos, rapport photos, photo identity/history, per-lead Mastra memory, stored drafts and human grading remain part of this bot. The adaptation supplies company context and durable work at those boundaries. It does not replace Manny with upstream role prose.

| Component | Current evidence | Remaining activation proof |
|---|---|---|
| Hindsight company bank | Created and configuration read back: `paperclip::f63a396b-956e-42ca-9916-88d98f4a54fe` | Runtime bank-scoped key, source-query pages, paid calls and end-to-end learning cycle |
| Neon target | Project `twilight-glade-11976094` identified | Metadata inventory captured; isolated restore, migration parity and approved cutover remain. This build has not changed the deployed connection |
| Manny control panel | Native `/manny` UI with immutable Postgres versions and private saved-version chat; local settings walkthrough passed | Approved hosted release and real configured-provider confirmation; last-used identity and Laya remain unresolved |
| Internal jobs | Five actions implemented below, with native HTTP authentication fixture | Actual authenticated hosted job, operator ownership and scheduler delivery |
| Quote followups | Durable registration and draft preparation adapters | Native Jobber quote ID/sentAt event mapping, authorized scheduler, real provider readbacks |
| Paperclip | Existing Dynamite company identity | A hosted assigned job completing through the actual runtime account; no new team/routine is implied |
| Laya | Historical lineage acknowledged; no recovered artifact or invocation contract | Actual versioned artifact/endpoint, invocation and evaluation receipt. Current status is unavailable, never score zero or a synthetic pass |
| Customer delivery | Existing draft and approved-send boundaries retained | Controlled pilot and actual recipient/delivery evidence after approval |

Development code and offline fixtures do not prove a deployment, hosted migration, paid memory operation or customer journey. Paid calls, customer sends, deploy, recurring activation and data-source cutover are outside this build's authorization.

## Source of truth and upstream mapping

GHL owns contacts, conversations and live CRM state. Jobber owns quote state. Postgres holds application records and execution receipts, with Neon the proposed target. Paperclip owns assignments. Hindsight holds reusable business context, never task authority. SigNoz is the operational evidence destination; this code alone does not prove a working alert reaches Alex.

[Selected pinned upstream source](../vendor/self-driving-agents/PROVENANCE.md) supplies the Agents Orchestrator, Workflow Architect, API Tester and Reality Checker roles. Native Mastra modules implement the host adaptation; the upstream installer has no Mastra/Paperclip integration. Keep one business bank, one assignment owner and the existing memory/provider route. Role documents do not grant tool access or authorize effects.

The intended Self-Driving Agents loop is:

1. List knowledge pages, read configured relevant pages and perform bounded targeted recall.
2. Add retrieved evidence to Manny's request as reference data. Preserve Qwen's single system message. Live STOP, ownership and deal state take priority.
3. After a new successful sales draft, retain a deterministic typed workflow outcome with stable document identity and tags.
4. Hindsight consolidates observations and refreshes each approved source-query page.
5. The next job reads the refreshed page and demonstrates the prior lesson with its source.

Today `customer-context.ts` always recalls after reading configured pages, even if pages cover the topic. It accepts at most three page IDs. Each page and recall block is bounded to 2,400 characters, with 9,000 characters total. Page absence, mismatched identity, wrong bank or provider failure is an error. Enabled knowledge failure holds the sales reply for a human rather than fabricating context.

Typed retention accepts only `eventId`, `outcome`, `dealState` and `photoUsed`. It serializes fixed text, hashes company/event identity into a `sales:` document ID and excludes free-form prose/transcripts. This is a structural allowlist, not semantic PII detection. The webhook currently emits `draft_created` or `quote_requested`; the type's other permitted values do not prove their producers are wired. Submission is asynchronous. A returned operation ID proves submission acknowledgement only, not consolidation, delivery or conversion. Missing operation ID or ambiguous submission becomes uncertain work requiring readback.

Hosted page creation and automatic refresh are not implemented by this adapter. The pinned bank template's refresh flags are reference material, not active settings. Do not claim the full loop until work A → retain → consolidation/refresh → work B has hosted evidence.

## Runtime configuration

[`.env.example`](../.env.example) lists the actual environment names. Keep every secret blank in source. `DATABASE_URL` serves both Mastra's Postgres storage and application tables. No database URL change has been performed here.

`HINDSIGHT_ENABLED=false` keeps context inactive. Enabling requires the exact fixed `PAPERCLIP_COMPANY_ID` and matching `HINDSIGHT_BANK_ID`, a bank-scoped `HINDSIGHT_API_KEY`, and up to three existing `HINDSIGHT_PAGE_IDS`. The transport rejects a key whose bank listing is anything other than exactly this bank. The normal shared `alex-agents` connection is not runtime proof and is never a fallback.

Leave `GHL_SEND_ENABLED`, `GHL_TEST_SEND_ENABLED`, `FLOW_TAG`, `FLOW_JOBBER_QUOTE` and `FLOW_MARVIN_TASK` false. A memory switch does not enable page refresh. There is no new scheduler or Laya environment variable. Test-number configuration does not authorize a send.

## Routes and operator actions

These paths are the strings passed to Mastra `registerApiRoute`. The installed Mastra Hono server was exercised at `/dynamite/jobs`: absent/wrong bearer returned 401, valid bearer reached the handler. Confirm the deployed base URL before hosted use. `MASTRA_API_TOKEN` authenticates internal routes. The GHL SMS webhook uses its existing `x-webhook-secret` boundary.

| Registered POST path | Body | Behavior |
|---|---|---|
| `/dynamite/jobs` | `{"action":"status"}` | Returns draft mode, grouped durable-work counts, Laya unavailable and configured memory-enabled flag. Initializes missing application/work tables, so this is not a strictly read-only database operation |
| `/dynamite/jobs` | `{"action":"work.resume"}` | Resumes at most ten saved pending/held/uncertain draft-completion intents. Pass returned `nextAfterDraftId` as optional `afterDraftId` to reach later pages without uncertain work starving the queue. Each enabled handoff step refreshes identity/STOP/ownership; completed or ambiguous child effects are never resent |
| `/dynamite/jobs` | `{"action":"knowledge","topic":"sales-rules"}` | Lists/reads pages then recalls. Other topics: `quote-handoff`, `coaching`. Requires activated context and makes metered calls |
| `/dynamite/jobs` | `{"action":"followups.register","contactId":"<verified GHL ID>","quoteRef":"<verified Jobber quote ID>","quoteSentAt":"<verified ISO timestamp>"}` | Operator supplies an already verified sent quote receipt. Persists registration and schedules draft work. Does not discover a Jobber event or send a quote |
| `/dynamite/jobs` | `{"action":"followups.run"}` | Checks due work and current provider/ownership state, prepares drafts only. Requires GHL and Jobber availability; no customer-send action exists here |
| `/dynamite/conversations/control` | `{"contactId":"<GHL ID>","phone":"<optional verified phone>","owner":"human"}` | Persists human takeover. `owner:"bot"` explicitly resumes ownership but cannot clear STOP |
| `/webhooks/ghl/sms` | Existing GHL event with `contactId` and `messageId` for normal drafting | Rejects missing identity before generation; handles STOP first, including contact-only/phone-only identity |

Malformed internal jobs return 400, unavailable durable storage returns 503, and authentication rejects unauthorized requests. Dependency failures return 503 without raw provider error bodies. Knowledge response text is company data; do not paste it into public logs.

Current Jobber status lookup is phone-based; it does not prove the status belongs to the exact registered quote reference. Verify that mapping before unattended use.

The quote runner defaults to up to four quote-followup drafts at 24, 48, 96 and 168 hours after the verified sent time. New quotes retain the active version's follow-up plan; existing queued quotes keep their plan. The global enable switch pauses processing. Default hours are 9am–9pm Detroit with at least 20 hours between followups. It honors STOP, human takeover, identity resolution, quote approval and customer reply. The separate existing three-hour personal-followup policy is not activated by this runner. A replacement quote reference cancels stale queued work when current state is checked. There is no in-process timer or new recurring job.

`pending` work can be claimed once. `dispatching` records preserve in-flight intent. `completed` means a stored effect/draft receipt, not customer delivery. `uncertain` means reconcile with the provider or draft database before any retry. `cancelled` is terminal for that work. After a crashed worker, establish it is inactive, inspect the authoritative provider/draft record and quarantine interrupted dispatches. Never reset all dispatching rows to pending. `work.resume` discovers unfinished draft completions; it cannot reset ambiguous provider effects. `PgDurableWorkStore.quarantineInterrupted` is the operator-code seam for quarantining a known inactive dispatch.

The draft and its completion intent are saved by the same INSERT. A database failure after that point leaves intent discoverable on duplicate inbound replay and `work.resume`. Stable child receipts prevent repeated quote/task/retention effects. An enabled handoff whose client is unavailable stays held and resumes when that dependency returns; it cannot count as completed just because the client is missing. STOP observed during generation produces an empty held draft without photos or follow-on effects. An ambiguous earlier followup cancels later sequences with a reconciliation reason rather than repeatedly reading providers.

## Fireworks fine-tune selection

**Alex's correction, October 22:** the prior scores were wrong/disputed; the requested baseline is the last bot configuration he personally used, not a newly ranked or simply newest fine-tune. Historical numbers below are lineage only and must not select the model. The exact last personally used model/configuration has not yet been verified. Latest saved full-bot run metadata identifies the base Qwen ID, while a later training record identifies v3c; neither alone proves Alex's last personal session. Preserve the current configuration until that session is recovered; do not claim it has been restored or replace it based on those scores.

Read-only account inspection on 2026-10-22 found both `dynamite-sales-qwen27b-v1` and `dynamite-sales-qwen27b-v3c` READY. The newer training job `dyn-sales-27b-v3c` is COMPLETED, based on `accounts/fireworks/models/qwen3p8-27b`. The account deployment listing and both models' `deployedModelRefs` were empty. READY establishes training completion, not an inference endpoint.

The historical 3.16 score belongs to the October 14 v1 generation, not v3c. The October 15 training record says v3c was not scored or deployed. Those old scores also lack exact prompt/tool/config binding; they do not establish the best model for this preserved bot today. The model metadata reports `supportsTools:false`; this is an unresolved compatibility signal, not a runtime tool test.

[Fireworks' current LoRA serving documentation](https://docs.fireworks.ai/fine-tuning/deploying-loras) requires an on-demand deployment for these adapters and recommends live merge for a single adapter. For live merge, the inference ID is `accounts/abloomster/models/dynamite-sales-qwen27b-v3c`; multi-LoRA uses the exact model plus `#` and verified deployment resource. Configure the returned verified ID through `FIREWORKS_SALES_MODEL` only after acceptance. No deployment is created by this code.

The existing `scripts/eval-agent.ts` now shares the runtime model selector and records its prompt hash, tool calls, usage, timing and explicit generation settings. Its existing startup and periodic spend checks are preserved. `tests/fixtures/fireworks-model-cases.jsonl` supplies ten synthetic cases; no paid evaluation has run. Unset `DATABASE_URL` and `GHL_API_KEY` for this synthetic comparison; this does not establish production retrieval/memory parity.

Before selecting v3c for customer work, approve a bounded serving/evaluation spend, match an available shape to the exact model version, deploy it, and verify the deployed model identity. Compare the same prompt, retrieved examples, history and generation settings against the existing talker using non-sensitive fixtures: quote/address progress, refusal to invent prices/dates, tool calls for prospect lookup/install/rapport photos, actual photo IDs/URLs, no-repeat behavior and human grading. Preserve the existing bot if any required behavior fails. Laya remains explicitly unavailable until its real invocation is recovered; do not substitute a fake Laya score. No training rerun is needed just to test v3c.

[Published on-demand pricing](https://fireworks.ai/pricing), read October 22, lists H100/H200 at $8 per GPU-hour and B200 at $13 per GPU-hour, billed per GPU second. A read-only match using the exact v3c resource returned validated shape `accounts/fireworks/deploymentShapes/sva2n3mh/versions/k9aui8v2`, Qwen3.8 27B BF16 on one H100. The earlier proposed 30-minute/$5 comparison is superseded pending recovery of Alex's last-used configuration; it was never approved. These serving instructions are candidate research, not the selected next action. Shape matching is not deployment success or a guaranteed billing cap. No paid serving or inference was started by this build.

## Manny control panel

Open `/manny` on this Mastra server and connect with the existing workspace access token. The token stays in page memory, never URLs, browser storage or version rows. The public shell contains no credentials. Native custom settings routes are `/dynamite/settings` and `/save`, `/activate`, `/restore`, plus authenticated `/photos/:photoId` JPEG previews and POST `/chat` for private saved-version conversations. Mastra reserves `/api` for its own routes.

The panel edits the exact Fireworks resource, original instructions, generation settings, six tools, approved photo enable/caption settings, quote follow-up cadence/quiet hours/messages, conversation memory/example settings, Hindsight selection and existing scorer sampling. Saving creates an inactive immutable version. **Use this version** switches with an atomic expected-active check; restore creates a new inactive copy. Native Agent hooks and the SMS route pin one version throughout a reply. Credentials, send activation and the unrecovered Laya identity remain read-only status. Personal follow-up timing is a saved preview-helper setting; no personal worker is active.

[Mastra Studio](https://mastra.ai/docs/studio/overview) model edits are temporary. [Mastra Editor](https://mastra.ai/docs/studio/editor), checked October 22, versions instructions/tools but cannot atomically version this full application setup or persist code-agent model changes. This implementation uses native Mastra dynamic Agent hooks, registerApiRoute and the existing PostgresStore instead of a second Editor history. See the [settings contract](manny-control-panel.md).

Verified locally: 162 offline tests, including real PostgreSQL version persistence/concurrency and native agent settings hooks; TypeScript and Mastra production build. A native Mastra HTTP server with a separate local PostgreSQL database passed one browser journey: save without activation, activate, restart/reconnect with edits intact, restore as a new draft, then use the restored settings. Narrow and desktop layouts were inspected. No production deployment or customer message occurred. After Alex’s separate $5 approval, one private preserved-model Fireworks reply and its approved photo were verified in the dashboard; the last-used fine-tune and Laya remain unverified. The local review uses synthetic settings, and does not prove hosted Neon migration or provider serving.

## Hindsight paths: current transport versus pinned examples

The runtime transport uses `https://api.hindsight.vectorize.io/v1/default`, with bearer authentication and encoded bank/page IDs. Source records its API shape as checked against the hosted OpenAPI schema on 2026-10-22.

| Operation | Current transport path |
|---|---|
| Key/bank identity | `GET /v1/default/banks` |
| Knowledge tree | `GET /v1/default/banks/{bank}/knowledge-base/tree` |
| Read page | `GET /v1/default/banks/{bank}/knowledge-base/pages/{page}`; reads `markdown` |
| Targeted recall | `POST /v1/default/banks/{bank}/memories/recall`, `budget:"low"`, `max_tokens:1024` |
| Typed retention | `POST /v1/default/banks/{bank}/memories`, `items` plus `async:true` |

Pinned `src/skill/SKILL.md` names host tools such as `agent_knowledge_list_pages`, `agent_knowledge_create_page` and ingest helpers. They are upstream host abstractions, not routes exposed here. Its raw-conversation/whole-document ingest instructions do not override the typed-outcome boundary. Older mental-model/page examples must not be copied as current hosted API contracts. Verify page-management and refresh schemas with the current official API before an approved activation; this transport exposes neither management operation.

## Migration inventory and isolated rehearsal

Metadata inspection is complete; data migration remains a plan. The local source configuration identifies Supabase project `jxhedtzoyzncojjoiqln`, Postgres 17.11. Metadata listed 49 non-system tables, with application SMS tables in both public and extensions schemas, plus Mastra tables and `rep_examples`. The Neon production-branch metadata listed crm, drizzle, neon_auth, ops and public schemas and no matching Mastra/SMS/durable-work table names. These are inventories and estimated row statistics, not exact data-parity evidence. Source local configuration has not been compared to deployed secrets. Preserve every actual schema/search path and rep-example vector dependency; no client rows were copied or inspected for this inventory.

1. Capture the current deployment revision, old database identity, schema/search paths, extensions, roles, grants, triggers and connection settings using the approved secret route. Record sanitized metadata only. Do not print connection strings.
2. Inventory every Mastra-owned table from the actual source database, including threads, messages, workflow/state and observability tables present. Do not assume their names from a documentation example. Record row counts, keys, relationships and timestamp bounds per table.
3. Inventory application tables: `sms_drafts` including unique `ghl_message_id`, `media_urls` and `photo_ids`; `sms_grades` and its draft foreign key; `sms_opt_outs`; plus new `sms_conversation_control`, `sms_phone_aliases`, `durable_sales_work` and `sales_followup_quotes` if present. Preserve contact/phone mappings and terminal STOP state. Record the existing source's RLS and event triggers; do not transplant vendor-specific Supabase triggers into Neon without testing.
4. Produce an encrypted off-machine schema/data backup through the established backup destination, record its timestamp and checksum privately, then prove it restores. Keep the old source intact. A local file or success log alone is insufficient durability evidence.
5. Rehearse restoration into an approved isolated Neon branch under `twilight-glade-11976094`. Match required Postgres extensions and ownership. Apply this revision's additive schema initialization there. Keep all external-effect and memory switches off. Never point a rehearsal at the deployed app.
6. Compare source versus restored table counts, primary keys, foreign-key validity and sampled non-sensitive checksums. Verify historical conversation retrieval, grade-to-draft linkage, no-repeat photos, opt-outs, ownership/aliases and unique work keys. Preserve timestamps/timezones and quoted arrays/JSON.
7. Exercise the selected Mastra build with the rehearsal connection: authenticated status, safe fixture draft persistence, STOP/takeover, duplicate event, concurrent claim and process-restart readback. No paid generation or customer send is included. Local Postgres integration tests do not establish hosted Neon parity.
8. Record the exact tested revision, target branch/database identity, comparison receipt, storage compatibility and rollback source. Stop before cutover if any parity item fails.

## Cutover, activation and rollback

Proceed only after Alex approves the exact production scope and any metered calls/customer pilot. An approved data cutover does not authorize customer messaging or automatic refresh.

1. Verify backup/restore and rehearsal evidence. Resolve Laya as an explicit unavailable component unless its real runtime contract has been recovered. Verify GHL/Jobber action ownership to avoid duplicate automations.
2. Pause inbound writes and approved send workers for the maintenance window. Record the final source watermark and restore/reconcile the final delta. Compare parity again. Establish one active writer before resuming; do not allow both databases to diverge.
3. Change only the approved deployed connection secret to the tested Neon target, then deploy the reviewed revision through the approved release path. Keep memory and effect switches off. Verify actual database identity privately, historical reads, status and operator takeover before resuming inbound traffic.
4. For separate memory approval, provision the bank-scoped runtime key through the existing connector/secret route and read back exact bank scope. Create up to three source-query pages through the current official API, record page IDs, and test enabled retrieval without changing company identity.
5. With explicit spend approval, submit one typed outcome from work A, obtain operation completion, approve/configure the desired consolidation/refresh policy, and read the refreshed page from work B. Record source/query/page identity. Do not count an async acknowledgement as the full loop.
6. Separately authorize and prove one internal Paperclip assignment, scheduler invocation and operator-visible failure. Supply a verified Jobber receipt to register followups until native quote event mapping is implemented and proved. Establish an alert that Alex actually receives in chat before unattended operation.
7. Run a separately approved controlled pilot through Manny, the intended photo, Marvin handoff and visible delivery/quote outcome. Keep human approval and STOP/takeover active. Enable each external-effect switch only for its approved owner and scope.

Rollback trigger: failed database identity/parity, missing history, failed STOP/takeover, duplicate effect, or unresolved provider acknowledgement. Pause writes/sends, disable new switches, capture durable-work and provider receipts, then restore the prior deployment and old connection using the release rollback procedure. If the new database has accepted writes, reconcile that delta into the chosen authoritative source before resuming. Switching the URL back alone can lose recent work. Keep both stores and backup evidence until reconciliation is proved; delete nothing as part of rollback.

## Evidence required before calling this live-ready

- Restored Neon parity and an approved single-writer cutover receipt.
- Authenticated hosted Mastra/Paperclip work completing after a restart with exact company mapping.
- Real pages → recall → typed retain → hosted consolidation/refresh → next-job retrieval evidence.
- Native Jobber mapping or a clearly operated verified-receipt workflow, plus a proven authorized scheduler.
- A controlled customer journey and delivered failure notification to Alex. Before activating approved followup delivery, also refresh customer-reply and exact registered-quote eligibility at the send boundary; the new runner proves draft preparation only.
- Laya's actual artifact/invocation and evaluation proof, or an accepted explicit limitation. Human grades remain available independently.

This runbook is grounded in the build plan and implementation contract dated 2026-10-22, the local modules named above and the pinned upstream source. Hosted outcomes remain open until their own readbacks exist.
