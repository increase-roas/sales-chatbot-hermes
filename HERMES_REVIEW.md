---
artifact_contract: "ce-handoff/v1"
created_at: "2026-10-23T08:16:25.015365+00:00"
title: "Hermes cleanup review of Manny / Dynamite"
summary: "Isolated public snapshot for cleanup with live-agent behavior, assets and version semantics preserved"
keywords: ["hermes", "mastra", "manny", "dynamite", "cleanup", "preservation"]
repository: "increase-roas/sales-chatbot-hermes"
source_head: "80ea98d36df17210c10cd920be0f2733f03e235b"
resume_focus: "Review and simplify the independent copy while preserving the live agent"
---

# Hermes review handoff

October 23 context supplement: read [AGENT_CONTEXT.md](AGENT_CONTEXT.md) first. It maps the actual source wiring, all settings groups, routes/authentication, database state, integrations, historical decisions, unresolved components and preservation checks. It is the same public-safe context guide added to the original local repo; it does not contain live credentials, customer records or an active-settings export.

## User request and authority

Alex's request: “make a separate public copy of the agent too so hermes can review it and clean it up while preserving everything in my live agent”. This document records that request. The copy is independent from the private source repository and its hosting.

Review and cleanup belong here. Changes to the private/live agent require a separately reviewed change; this handoff does not grant deployment, database migration, model switching, paid provider calls, customer contact or credential access. Do not assume old approval/budget prose in source documents grants a new action.

## Captured state

This snapshot captures the full committed development branch `feat/dynamite-self-driving` at the source revision above. Runtime source, tests, configuration templates, dependency manifests/lockfile and approved photo assets are unchanged. `COPY_PROVENANCE.json` binds each retained original file to its SHA-256 hash and lists intentional omissions. The original private Git history and historical operator/review evidence are absent.

The source branch is a development build, not proof of what is deployed. Do not describe every implementation as operational merely because a module exists. Existing documents identify unresolved model-use evidence, Laya and integration/cutover work. Their historical dates/status claims must be checked before being called current.

## Preservation contract

Preserve these while simplifying implementation:

- Manny's current instructions, voice and model-selection behavior. Do not pick a different model or a newer fine-tune based on disputed historical scores. The exact last personally used model remains unresolved in the source documentation.
- All six tool contracts: prospect lookup, quote price, propose date, book install, install photo and rapport photo. Do not remove a tool merely because an offline scan sees no ordinary import/call site.
- The control panel's appearance, settings fields, loading/error/empty states and saved-version chat. Retain immutable saved versions; Save is inactive, Use is atomic, and Restore creates a new inactive version. Keep a request pinned to one settings version.
- Approved install and rapport photos: retain IDs, matching/caption/enable behavior, consent boundaries, authenticated previews and exact bundled asset bytes. `tests/photo-portability.test.ts` is the existing byte oracle; no original private photo files are needed to read the bundled approved assets.
- Conversation memory and human grading; STOP/unsubscribe, human ownership, stage transitions, consent and draft approval behavior. No duplicate customer send or silent activation.
- Durable job identity, quote followups, deduplication, stored outcomes, restart recovery and handling of uncertain external effects.
- Existing GHL, Jobber, Postgres, Hindsight and scorer interfaces. Do not replace an unresolved integration with a substitute implementation and claim it is the original.

## Start from these artifacts

1. `AGENT_CONTEXT.md`: source-pinned architecture, external-state inventory, preservation requirements and known gaps; then `package.json`, `package-lock.json` for actual dependencies/check commands.
2. `src/mastra/agents/sales-agent.ts`: baseline instructions and native tool bindings; `tests/bot-preservation.test.ts` checks the preserved prompt/photo tools.
3. `docs/manny-control-panel.md`: version, activation, restore and chat contracts; `tests/control-settings.test.ts` and `tests/control-panel-credentials.test.ts` own key regressions.
4. `docs/dynamite-self-driving.md`: workflow ownership, native adapter boundaries, recovery and activation gaps.
5. `tests/conversation-control.test.ts`, `tests/durable-work.test.ts`, `tests/followup-runtime.test.ts`, `tests/ghl-send.test.ts`: approval, ownership and durable-work behavior.
6. `tests/photo-portability.test.ts`, `src/mastra/photo-library.ts`: all approved photo identities and preservation oracle.

## Suggested review sequence — author's recommendation

Establish a baseline, map concrete problems to source evidence, and propose bounded changes. Work one area at a time. For every removal, first determine why it exists and what behavior/test owns it. Run the relevant offline regression tests and compare the control panel's before/after behavior and screenshots. Report actual failing tests separately from proposed improvements.

Upstream Superpowers supports Hermes and is a possible workflow aid, not a dependency of this agent. Installing it was not part of creating this copy. Do not stack multiple orchestration frameworks merely to perform the review.

Return a concise findings list and a branch/PR in this review repository: source locations, proposed change, preserved requirements, tests actually run and remaining gaps. Public-source evidence must be researched when a proposed fix depends on current external behavior; local transformations supported entirely by the code need direct verification. No automatic merge back to the private agent is configured.

## Verification scope

The snapshot provenance proves the captured source bytes, not runtime compatibility, deployment, paid model quality, live database state or end-to-end customer operation. A secret scanner cannot prove absence of every sensitive value. Historical review/customer/billing logs and private history were deliberately omitted.
