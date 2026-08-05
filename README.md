# Agent Team Orchestrator

Agent Team Orchestrator is a local-first control plane that lets Codex CLI and Claude Code CLI work like a small engineering team without introducing a multi-user SaaS stack.

The v0.1 design combines the strongest ideas found during a source-level review of Spexcode, QM, Buzz, Compound Engineering Plugin, Open Code Review, TencentDB Agent Memory, ECC, and Matt Pocock's skills:

- one SQLite authority for tasks, leases, attempts, outbox entries, and audit events;
- atomic task claims with TTL leases and generation/token fencing;
- bounded channels with explicit backpressure;
- HMAC-signed, hash-chained events;
- exact-OID Git worktrees owned by the controller;
- normalized Codex and Claude streaming adapters;
- no automatic merge or destructive worktree cleanup in v0.1.

## Requirements

- Node.js 22.16 or newer
- Git
- Codex CLI and/or Claude Code CLI, already authenticated by the local operator
- A Git repository with at least one commit before adding work

There are no external runtime dependencies. SQLite is provided by Node's built-in `node:sqlite` module.

## Quick start

```bash
npm test
node bin/agent-team.mjs init
node bin/agent-team.mjs doctor

node bin/agent-team.mjs task add \
  --title "Implement the first vertical slice" \
  --description "Build, test, and commit the smallest end-to-end slice" \
  --adapter codex \
  --idempotency-key first-slice

node bin/agent-team.mjs task list
node bin/agent-team.mjs worker run --worker builder-1 --adapter codex
node bin/agent-team.mjs events verify
```

The project database, event key, worktrees, and run artifacts live outside the repository under:

```text
${AGENT_TEAM_STATE_ROOT:-~/.local/state/agent-team-orchestrator}/projects/<repo-id>/
```

## Safety model

The orchestrator assumes one trusted local operator, but it does not trust child Agent processes or their output.

- A stale Agent cannot heartbeat, complete, fail, enqueue, or acknowledge work after its lease generation changes.
- Prompts are sent over stdin. The orchestrator never interpolates prompts into shell commands.
- Child environments use an allowlist, and unknown environment overrides are rejected. The event HMAC key is never inherited or exposed through runtime context.
- Worktrees are prepared from exact commit OIDs under a managed root.
- The state root and signing key must live outside the repository; symlinked state roots and key files are rejected.
- Automatic worktree deletion and branch deletion are deliberately absent from v0.1.
- Automatic landing into `main` is deliberately absent until reviewed-OID CAS landing is implemented and verified.

v0.1 trusts the local operator's installed `git`, `codex`, and `claude` executables. `agent-team doctor` reports the absolute executable paths it resolved. Do not launch the orchestrator from an environment whose `PATH` is controlled by an untrusted repository.

See [Architecture](docs/ARCHITECTURE.md), [Security](docs/SECURITY.md), and [Roadmap](docs/ROADMAP.md).

## Development lifecycle

`main` holds the verified v0.1 baseline. Ongoing self-improvement happens on `dev`, then returns through independent review and verification before promotion to `main`.
