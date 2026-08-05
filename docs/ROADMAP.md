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

## v0.2 — review transaction

- Builder, Reviewer, and Verifier role packets
- Candidate commit manifest
- Deterministic diff/rule review surface
- Independent verification receipts
- Exact reviewed-OID `git update-ref <new> <old>` landing
- Recovery after controller crash

## v0.3 — self-improvement loop

- Scheduler daemon with fairness across role channels
- Retry budgets and dead-letter inspection
- Dev-branch dogfooding workflow
- Automated architecture/test/security critique gates
- Release candidate promotion from `dev` to `main`

## v0.4 — governed memory

- L0 raw run history
- L1 atomic facts
- L2 reusable incidents and experience
- L3 curated role/project knowledge
- Per-role memory loadouts
- Explicit, create-only decision and handoff vault
