# Agent Team Orchestrator

Agent Team Orchestrator is a local-first control plane that lets Codex CLI and Claude Code CLI work like a small engineering team without introducing a multi-user SaaS stack.

The current `0.2.0-dev.0` branch extends the original local kernel with the first Project Brain slice: versioned project assets, explicit role loadouts, bounded prompt injection, and read-only GUI/CLI projections over the same SQLite authority.

The design combines the strongest ideas found during a source-level review of Spexcode, QM, Buzz, Compound Engineering Plugin, Open Code Review, TencentDB Agent Memory, ECC, and Matt Pocock's skills:

- one SQLite authority for tasks, leases, attempts, outbox entries, and audit events;
- governed Project Brain assets and per-role loadout bindings;
- atomic task claims with TTL leases and generation/token fencing;
- bounded channels with explicit backpressure;
- HMAC-signed, hash-chained events;
- exact-OID Git worktrees owned by the controller;
- normalized Codex and Claude streaming adapters;
- no automatic merge or destructive worktree cleanup;
- no automatic Planner, no automatic parent/child Agent DAG synthesis, and no automatic memory extraction or write-back from model output.

## Requirements

- Node.js 22.16 or newer
- Git
- Codex CLI and/or Claude Code CLI, already authenticated by the local operator
- A Git repository with at least one commit before adding work

There are no external runtime dependencies. SQLite is provided by Node's built-in `node:sqlite` module.

## Quick start: run the local team continuously

```bash
npm test
node bin/agent-team.mjs init
node bin/agent-team.mjs doctor

npm run daemon -- --repo . --concurrency 2
```

`agent-team daemon` is the recommended daily entry point. It starts both the loopback-only GUI and a resident scheduler, prints a local capability URL, and keeps polling SQLite for queued work. Leave that terminal running and open the exact printed URL in a browser.

Create tasks from the GUI or another terminal. The daemon automatically claims ready tasks and routes each one to the `codex` or `claude` adapter selected on the task:

```bash
node bin/agent-team.mjs task add \
  --title "Implement the first vertical slice" \
  --description "Build, test, and commit the smallest end-to-end slice" \
  --adapter codex \
  --idempotency-key first-slice

node bin/agent-team.mjs task list
```

Project Brain content is controller-written and role-scoped. You can create versioned assets, assemble them into loadouts, and bind a loadout to a role before queuing work:

```bash
node bin/agent-team.mjs asset add \
  --key memory/project-safety \
  --kind memory \
  --layer l3 \
  --title "Project safety doctrine" \
  --content "Never land an unverified candidate into main."

node bin/agent-team.mjs loadout create \
  --key builder/default \
  --role builder \
  --asset <ASSET_ID>:direct:10

node bin/agent-team.mjs loadout bind \
  --role builder \
  --loadout <LOADOUT_ID> \
  --expect-unbound true
```

When a worker claims a task for that role, the controller resolves the active role loadout, renders only the bounded allowed reference material into the task prompt, and records a loadout snapshot receipt in the signed event log.

Project Brain is not a secret store. `direct` and `summary` loadout entries are trusted, operator-curated guidance: they place asset text into the CLI prompt and that material may be echoed back by the model in its final output. Do not put arbitrary external Markdown, copied model output, or unreviewed documents in those modes; use `reference` or `tool` for material that should remain locator-only. Runtime audit events retain status and session metadata, not the Agent's final message or terminal message.

Press `Ctrl-C` in the daemon terminal for a graceful stop. In-flight Agent work is allowed to finish within its configured timeout; the controller does not merge, push, delete branches, or delete worktrees during shutdown.

For a GUI without automatic queue consumption, use:

```bash
npm run gui -- --repo .
```

The GUI-only mode supports inspection and explicit manual runs, but it is not resident scheduling.

## One-shot CLI workflow

The lower-level commands remain useful for debugging and manual control:

```bash
node bin/agent-team.mjs init

node bin/agent-team.mjs task add \
  --title "Implement the first vertical slice" \
  --description "Build, test, and commit the smallest end-to-end slice" \
  --adapter codex \
  --idempotency-key first-slice

node bin/agent-team.mjs task list
node bin/agent-team.mjs worker run --worker builder-1 --adapter codex
node bin/agent-team.mjs events verify
```

The resident daemon provides execution continuity; it does not yet invent improvement work, synthesize a Planner-owned task tree, spawn an automatic parent/child Agent DAG on its own, extract memory from runs, write new Project Brain assets automatically, or promote changes by itself. The planned self-improvement loop will enqueue bounded critique/build/review/verification tasks against `dev`, then require an independently verified promotion transaction.

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
- Automatic worktree deletion and branch deletion are deliberately absent.
- Automatic landing into `main` is deliberately absent until reviewed-OID CAS landing is implemented and verified.
- Workers do not write Project Brain assets or bindings directly from model output. Project Brain writes go through controller APIs only.

The current branch trusts the local operator's installed `git`, `codex`, and `claude` executables. `agent-team doctor` reports the absolute executable paths it resolved. Do not launch the orchestrator from an environment whose `PATH` is controlled by an untrusted repository.

See [Project Brain](docs/PROJECT-BRAIN.md), [GUI and daemon](docs/GUI.md), [Architecture](docs/ARCHITECTURE.md), [Security](docs/SECURITY.md), and [Roadmap](docs/ROADMAP.md).

## Development lifecycle

`main` holds the last verified stable baseline. `dev` is the current self-iteration branch, including the `0.2.0-dev.0` Project Brain work. Ongoing self-improvement still returns through independent review and verification before promotion to `main`.
