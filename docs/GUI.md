# GUI and resident daemon

## Recommended start

From the repository you want the Agents to work on:

```bash
node /path/to/agent-team-orchestrator/bin/agent-team.mjs init --repo .
node /path/to/agent-team-orchestrator/bin/agent-team.mjs daemon --repo . --concurrency 4
```

When developing this repository itself, the equivalent command is:

```bash
npm run daemon -- --repo . --concurrency 4
```

The command prints a loopback capability URL such as `http://127.0.0.1:4317/#token=...`. Keep the terminal open and visit that exact URL. The browser stores the capability for the tab session and removes it from the visible address after bootstrap. Tasks created from the page or CLI are persisted in SQLite and automatically consumed by the resident worker slots.

The same GUI server also exposes Project Brain read projections for project assets and role loadouts. In this slice those are inspection surfaces only; creating assets, creating loadouts, and rebinding active role context still happen through controller APIs and CLI commands.

The task dialog can create either one ordinary Agent task or one Agent-team root. Team mode fixes the role to Planner and exposes bounded adapter routing for Builder, Researcher, Test, Reviewer, and Verifier. The dashboard renders the durable parent/child forest, sibling dependency hints, `waiting_children`, and role-specific activity from the same SQLite snapshot.

## Two local modes

| Command | GUI | Automatic queue polling | Intended use |
| --- | --- | --- | --- |
| `agent-team daemon` | Yes | Yes | Normal daily operation |
| `agent-team gui` | Yes | No | Inspection and explicit manual runs |

Both modes use the same project database and the same fenced worker implementation. In daemon mode, manual “run now” launches are disabled so `--concurrency` remains the total in-process Agent limit. Starting multiple controller processes is safe at the claim layer, but normally unnecessary; one resident daemon should own parallelism for a workstation.

For Project Brain, the GUI currently mirrors:

- `/api/project-assets` for bounded asset listings
- `/api/role-loadouts` for role bindings, versioned loadouts, and the currently resolved role loadout

These are read-only projections over SQLite. They do not make the browser a second source of truth.

## What remains resident

The daemon is a foreground process. While it is alive it:

- keeps the GUI available;
- polls the durable SQLite queue;
- runs at most `--concurrency` Agent attempts at once;
- renews each active lease through the existing worker heartbeat;
- waits on explicit backpressure instead of dropping review messages;
- records normalized runtime results and signed audit events;
- survives an individual worker-loop exception and continues polling.

Use a dedicated terminal or terminal multiplexer if you want it out of the way. Press `Ctrl-C` to stop accepting new work and wait for current work to settle. This release does not install a login item or survive a machine reboot automatically.

The launch URL is a local mutation capability. Do not paste it into task prompts, logs, or shared messages. Opening the bare loopback origin without its fragment produces a read-only page session until the exact launch URL is opened again.

## What “continuous self-improvement” means here

Residency solves execution continuity, not autonomous decision policy. The daemon executes durable tasks continuously and can expand an explicitly submitted team root through a bounded Planner. It does not create speculative work, accept arbitrary recursive Agent DAGs, extract memory from runs, write Project Brain assets back automatically, merge its own candidates, or promote `dev` to `main`.

The safe self-improvement path is:

```text
bounded team task on an exact dev OID
  -> Planner-controlled fixed fan-out
  -> Builder candidate + Research/Test reports
  -> independent Reviewer
  -> independent Verifier with required check receipts
  -> reviewed-OID promotion transaction
```

The team stages can now be queued and run by the resident daemon. Promotion remains deliberately absent until exact-OID compare-and-swap landing and recovery tests are complete.

Project Brain is also not a secret-management feature. If a bound loadout uses `direct` or `summary`, that asset text enters the CLI prompt and may be repeated by the model. `reference` and `tool` modes only inject constrained locator metadata, not the underlying full source body.

## Useful options

```text
--concurrency N   Maximum simultaneous worker slots (default 1, maximum 64)
--poll-ms N       Delay after idle/failure outcomes (default 1000)
--lease-ms N      Task lease duration renewed by the worker (default 30000)
--timeout-ms N    Maximum runtime for each Agent attempt (default 1800000)
--host HOST       Loopback host only (default 127.0.0.1)
--port PORT       GUI port; use 0 to select an available port
--state-root PATH Override the external project-state root
```

Increasing concurrency means more simultaneous Codex/Claude processes and worktrees. Start with `4` for the fixed team workflow if the repository and local model quotas can support Builder, Researcher, and Test fan-out; use `2` on a tighter workstation.
