# Changelog

## 0.1.1 — 2026-08-05

- absorb child-stdin `EPIPE` races when a command exits before reading input;
- treat failed delivery of a non-empty Agent prompt as an explicit runtime failure;
- add Linux/Node 22 regression coverage for fast-exit subprocesses.

## 0.1.0 — 2026-08-05

Initial local-first control-plane baseline:

- SQLite-backed task DAG and fencing model
- bounded outbox and explicit backpressure
- signed hash-chain audit log
- exact-OID Git worktree preparation
- Codex and Claude streaming adapters
- CLI, doctor, tests, and security documentation

Automatic landing and destructive worktree cleanup are intentionally deferred.
