# Agent Team Orchestrator

Agent Team Orchestrator is a local-first control plane that lets Codex CLI and Claude Code CLI work like a small engineering team without introducing a multi-user SaaS stack.

The current `0.2.0-dev.1` branch combines the Project Brain foundation with the first executable Agent-team slice. A user-submitted team task now runs a bounded Planner, atomically creates a fixed parent/child DAG, fans out Builder/Researcher/Test work, and fans in through independent Reviewer and Verifier gates.

The design combines the strongest ideas found during a source-level review of Spexcode, QM, Buzz, Compound Engineering Plugin, Open Code Review, TencentDB Agent Memory, ECC, and Matt Pocock's skills:

- one SQLite authority for tasks, lease generations, parent/child lineage, outbox entries, and audit events;
- governed Project Brain assets and per-role loadout bindings;
- atomic task claims with TTL leases and generation/token fencing;
- bounded channels with explicit backpressure;
- HMAC-signed, hash-chained events;
- exact-OID Git worktrees owned by the controller;
- normalized Codex and Claude streaming adapters;
- no automatic merge or destructive worktree cleanup;
- a bounded, explicit team workflow without automatic merge, autonomous task invention, or automatic memory write-back from model output.

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

npm run daemon -- --repo . --concurrency 4
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

For a high-level request, submit one team task instead of manually creating every role:

```bash
node bin/agent-team.mjs team add \
  --title "Implement the first vertical slice" \
  --description "Plan, build, research, review, and verify the smallest complete slice" \
  --adapter codex \
  --base dev \
  --idempotency-key first-team-slice
```

The Planner is read-only and may return only the strict `team.plan.v1` contract. The controller, not the model, creates the fixed DAG:

```text
Planner
  ├─ Builder      (candidate commit)
  ├─ Researcher   (read-only evidence report)
  └─ Test         (read-only test analysis)
         ↓ barrier
      Reviewer    (exact Builder candidate)
         ↓
      Verifier    (exact Builder candidate + required checks)
         ↓
  deterministic parent aggregate
```

The parent task remains `waiting_children` without occupying a worker slot. When every child reaches a terminal state, SQLite wakes the parent for a deterministic aggregate and publishes one final review-channel delivery.

If a team run fails, retry the failed parent from the GUI or with `agent-team task retry`. The retry keeps the validated plan and child lineage, requeues only failed lanes and their failed dependents, reuses completed work, and returns to the aggregate after recovery; it does not run Planner or fan out duplicate slices again.

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

The resident daemon provides execution continuity and can execute an explicitly submitted Planner-owned task tree. It still does not invent speculative improvement work, recursively accept arbitrary Agent-created roles or DAGs, extract memory from runs, write Project Brain assets automatically, merge candidates, or promote changes by itself. A future self-improvement policy may enqueue bounded team tasks against `dev`, but promotion still requires an independently verified exact-OID transaction.

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
- Planner, Reviewer, and Verifier outputs are strict, size-bounded JSON contracts. Unknown fields, missing required checks, read-only worktree mutations, and malformed verdicts fail closed.
- Parent/child lineage can only be created by a fenced atomic fan-out transaction. A normal task-creation call cannot attach children to queued or terminal parents.

The current branch trusts the local operator's installed `git`, `codex`, and `claude` executables. `agent-team doctor` reports the absolute executable paths it resolved. Do not launch the orchestrator from an environment whose `PATH` is controlled by an untrusted repository.

See [Team workflow](docs/TEAM-WORKFLOW.md), [Project Brain](docs/PROJECT-BRAIN.md), [GUI and daemon](docs/GUI.md), [Architecture](docs/ARCHITECTURE.md), [Security](docs/SECURITY.md), and [Roadmap](docs/ROADMAP.md).

## Development lifecycle

`main` holds the last verified stable baseline. `dev` is the current self-iteration branch, including the `0.2.0-dev.1` Project Brain and automatic team-workflow slice. Ongoing self-improvement still returns through independent review and verification before promotion to `main`.
