# Self-Driving Agents source provenance

Retrieved for this development adaptation on 2026-10-22.

- Upstream: [vectorize-io/self-driving-agents](https://github.com/vectorize-io/self-driving-agents).
- Pinned revision: `9687e5864e7986a06f2aaf492221dd1d2934f91e`.
- Revision URL: [pinned source tree](https://github.com/vectorize-io/self-driving-agents/tree/9687e5864e7986a06f2aaf492221dd1d2934f91e).
- This folder contains selected raw upstream documents and a bank template. It is not a complete installer checkout.
- Raw upstream files remain separate from this provenance record and the Mastra adapter in `src/mastra/`.

## Included upstream files

| Path | Purpose in this adaptation |
|---|---|
| `README.md` | Upstream overview, supported hosts and stated license |
| `src/skill/SKILL.md` | Knowledge pages, recall, retention and consolidation lifecycle |
| `specialized/exec-ops/agents-orchestrator.md` | Coordinating build role |
| `specialized/engineering-meta/workflow-architect.md` | Workflow and handoff design role |
| `testing/quality/reality-checker.md` | Independent evidence review role |
| `testing/automation/api-tester.md` | Acceptance-case design role |
| `specialized/customer-service/customer-service.md` | Customer-service role source |
| `sales/ops/pipeline-analyst.md` | Sales operations role source |
| `sales/bank-template.json` | Sales-bank mission and refresh-policy reference |

## License evidence and limits

The pinned upstream README states **MIT**. The inspected upstream source tree contained no `LICENSE` file. This record preserves that evidence; it does not invent copyright holders, a copyright notice or missing license text. Resolve the missing notice with upstream before redistributing a packaged derivative beyond this reviewable development branch.

## Host adaptation

The pinned installer supports Claude, Claude Code, Hermes, OpenClaw and NemoClaw. It does not establish native Mastra or Paperclip support. The installer was not run for this build.

The local adapter preserves the existing Mastra Manny agent, Qwen talker, installation/rapport photo tools and human grading. Paperclip remains the assignment owner. Hindsight holds one company bank rather than the upstream per-agent defaults. The upstream raw-conversation ingestion instruction is deliberately narrowed to typed business outcomes here. Raw CRM conversations and personal contact details stay in their authoritative systems.

The intended lifecycle remains: knowledge pages and recall at job start, typed outcome retention after work, hosted consolidation and source-query page refresh, then updated knowledge at the next job. Hosted refresh and the cross-job cycle remain unproved. See [the operating runbook](../../docs/dynamite-self-driving.md) for current paths and activation evidence.
