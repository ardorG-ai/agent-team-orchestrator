# Roadmap

## v0.1 — reliable local kernel

- SQLite authority and migrations
- Task DAG and idempotent creation
- Atomic claims, TTL leases, and fencing
- Bounded channel/outbox with visibility leases
- HMAC hash-chain events and verification
- Exact-OID worktree preparation
- Codex and Claude non-interactive adapters
- CLI, tests, doctor, and JSON output
- Loopback-only local team GUI
- Resident daemon with bounded worker slots and graceful shutdown

## v0.2.0-dev.0 — Project Brain foundations now on `dev`

- Versioned `project_assets` for `memory`, `skill`, and `knowledge`
- `l1`/`l2`/`l3` memory layering on governed assets
- Versioned `role_loadouts` with ordered entries, injection modes, and byte budgets
- Explicit active-role bindings with optimistic concurrency checks
- Bounded role-reference injection at task claim time
- Signed loadout snapshot receipts that audit hashes and truncation without logging raw memory text
- CLI surfaces for asset and loadout create/list/show/bind flows
- GUI read projections for project assets, role loadouts, bindings, and resolved role context

## Next toward v0.2 — review transaction and promotion safety

- Builder, Reviewer, and Verifier role packets
- Candidate commit manifest
- Deterministic diff/rule review surface
- Independent verification receipts
- Exact reviewed-OID `git update-ref <new> <old>` landing
- Recovery after controller crash

## v0.3 — self-improvement loop

- Fair scheduling across role channels
- Retry budgets and dead-letter inspection
- Dev-branch dogfooding workflow
- Automated architecture/test/security critique gates
- Planner-mediated improvement planning
- Explicit parent/child task graphs for build-review-verify workflows
- Release candidate promotion from `dev` to `main`
- Optional native desktop wrapper and operating-system auto-start

Not implemented in the current branch:
- No automatic Planner that invents and decomposes work on its own
- No automatic parent/child sub-Agent DAG synthesis
- No automatic extraction, summarization, or write-back from runs into Project Brain

## v0.4 — richer governed memory

- L0 raw run history
- L1 atomic facts
- L2 reusable incidents and experience
- L3 curated role/project knowledge
- Per-role memory loadouts
- Explicit, create-only decision and handoff vault
