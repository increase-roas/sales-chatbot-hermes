# Manny / Dynamite — Hermes review copy

Independent public review snapshot of the Mastra sales agent. Start with [AGENT_CONTEXT.md](AGENT_CONTEXT.md) for the full wiring, data/state inventory, preservation contract and known gaps, then [HERMES_REVIEW.md](HERMES_REVIEW.md) for the review handoff.

This repository contains the committed agent source, native Manny control panel, six tools, workflows, approved send-safe photo library, tests, dependency lockfile and operating documentation. Runtime source and tests are unchanged from the captured private build.

- Source branch: `feat/dynamite-self-driving`
- Source revision: `80ea98d36df17210c10cd920be0f2733f03e235b`
- Snapshot date: October 23, 2026
- Per-file hashes and omissions: [COPY_PROVENANCE.json](COPY_PROVENANCE.json)

The private application's Git history, historical billing/review/conversation artifacts, credentials, installed dependencies, local databases and generated build output are excluded. This new repository has no deployment connection or live application credentials. The original agent/repository was not changed to create it.

## Review objective

Alex requested cleanup while preserving the live agent's behavior and appearance. Treat this repository as the isolated place to propose and test those changes. Preserve the model selection, Manny instructions, tool contracts, photo identities and exact approved bytes, saved settings/version behavior, consent/ownership/STOP handling, draft approvals, durable work and recovery. See the handoff for details and known unresolved integrations.

## Local checks

Requires a Node.js version supporting the TypeScript test files and dependencies from the lockfile.

```sh
npm ci
npm test
npm run typecheck
npm run build
```

Inspect scripts before running them. Do not supply live credentials for a review. The Node test suite uses offline fixtures. Real-Postgres integration tests create their own temporary Unix-socket clusters when local PostgreSQL binaries and the installed driver are available; they may skip when those prerequisites are missing. They do not use the live application database. The source also contains historical evaluation/training/billing/send scripts: they are preserved for review, not instructions to execute them.

`.env.example` documents connection names using placeholders. Starting the server or using a real model requires separately configured development credentials and can cause provider calls. No such access is granted by this public repository.

## Code landmarks

- `src/mastra/agents/sales-agent.ts`: Manny instructions and tool registration.
- `src/mastra/control-panel.ts`, `control-settings.ts`, `control-chat.ts`: UI, versioned settings and private saved-version chat.
- `src/mastra/routes/`: HTTP boundaries.
- `src/mastra/conversation-control.ts`, `drafts.ts`, `draft-completion.ts`, `durable-work.ts`: ownership, approval, deduplication and recovery.
- `src/mastra/photo-library.ts`, `photo-assets.ts`, `photos.ts`: approved photo identities and bundled assets.
- `docs/manny-control-panel.md`, `docs/dynamite-self-driving.md`: detailed contracts and activation gaps; historical status statements are not current deployment proof.
- `tests/`: regression and offline fixtures, including preservation and photo-byte checks.

GitHub access to this repository is public. It is a source-review copy, not a deployment or a working copy of the private production database/model account.
