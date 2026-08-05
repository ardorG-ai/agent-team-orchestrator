# Changelog

## Unreleased

- add a loopback-only local team GUI with task, adapter-activity, review, backpressure, and signed-event views;
- add a resident `agent-team daemon` that runs the GUI and bounded worker slots continuously;
- route daemon and GUI-triggered work through the same fenced `runWorkerOnce` execution boundary;
- expose resident scheduler health in the GUI without exposing claim or lease tokens;
- keep daemon concurrency authoritative by disabling out-of-budget manual launches and draining GUI runs before store shutdown;
- apply the existing finite Agent runtime budget to daemon and GUI-launched attempts;
- bootstrap mutation authority through a non-HTTP launch fragment instead of serving the capability in page HTML;
- document foreground residency, graceful shutdown, and the boundary between queue execution and future self-improvement policy.

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
