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

## v0.2.0-dev.0 — Project Brain foundations

- Versioned `project_assets` for `memory`, `skill`, and `knowledge`
- `l1`/`l2`/`l3` memory layering on governed assets
- Versioned `role_loadouts` with ordered entries, injection modes, and byte budgets
- Explicit active-role bindings with optimistic concurrency checks
- Bounded role-reference injection at task claim time
- Signed loadout snapshot receipts that audit hashes and truncation without logging raw memory text
- CLI surfaces for asset and loadout create/list/show/bind flows
- GUI read projections for project assets, role loadouts, bindings, and resolved role context

## v0.2.0-dev.1 — executable Agent team now on `dev`

- Explicit `team add` and GUI team-task creation
- Strict read-only Planner contract with fixed Builder/Researcher/Test/Reviewer/Verifier DAG
- Schema v3 parent/slice lineage and `waiting_children`
- Fenced atomic child fan-out with sibling DAG validation
- Dependency-failure propagation and durable parent wake-up
- Generation-fenced team-root retry that reuses the original DAG and completed children
- Controller-owned, task-scoped candidate commits for mutable CLI runs
- Exact Builder candidate handoff to independent Reviewer and Verifier
- Bounded untrusted handoffs and fail-closed structured verdicts
- Deterministic parent aggregate and one final review delivery
- GUI six-role roster and clickable Agent tree

## Next toward v0.2 — promotion safety and durable attempts

- Candidate commit manifest
- Deterministic diff/rule review surface
- Independent verification receipts
- Durable attempt/session projections across daemon restart
- Exact reviewed-OID `git update-ref <new> <old>` landing
- Recovery after controller crash

## v0.3 — self-improvement loop

- Fair scheduling across role channels
- Retry budgets and dead-letter inspection
- Dev-branch dogfooding workflow
- Automated architecture/test/security critique gates
- Policy for proposing bounded improvement tasks without an unbounded autonomous backlog
- Release candidate promotion from `dev` to `main`
- Optional native desktop wrapper and operating-system auto-start

Not implemented in the current branch:
- No autonomous Planner that invents work without an explicit team task
- No arbitrary or recursive model-selected sub-Agent DAG
- No automatic extraction, summarization, or write-back from runs into Project Brain

## v0.4 — richer governed memory

- L0 raw run history
- L1 atomic facts
- L2 reusable incidents and experience
- L3 curated role/project knowledge
- Per-role memory loadouts
- Explicit, create-only decision and handoff vault
