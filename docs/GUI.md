# GUI and resident daemon

## Recommended start

From the repository you want the Agents to work on:

```bash
node /path/to/agent-team-orchestrator/bin/agent-team.mjs init --repo .
node /path/to/agent-team-orchestrator/bin/agent-team.mjs daemon --repo . --concurrency 2
```

When developing this repository itself, the equivalent command is:

```bash
npm run daemon -- --repo . --concurrency 2
```

The command prints a loopback capability URL such as `http://127.0.0.1:4317/#token=...`. Keep the terminal open and visit that exact URL. The browser stores the capability for the tab session and removes it from the visible address after bootstrap. Tasks created from the page or CLI are persisted in SQLite and automatically consumed by the resident worker slots.

## Two local modes

| Command | GUI | Automatic queue polling | Intended use |
| --- | --- | --- | --- |
| `agent-team daemon` | Yes | Yes | Normal daily operation |
| `agent-team gui` | Yes | No | Inspection and explicit manual runs |

Both modes use the same project database and the same fenced worker implementation. In daemon mode, manual “run now” launches are disabled so `--concurrency` remains the total in-process Agent limit. Starting multiple controller processes is safe at the claim layer, but normally unnecessary; one resident daemon should own parallelism for a workstation.

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

Residency solves execution continuity, not decision policy. The daemon executes durable tasks continuously, but it does not yet create speculative work, merge its own candidates, or promote `dev` to `main`.

The safe self-improvement path is:

```text
bounded improvement proposal
  -> builder task on an exact dev OID
  -> independent review task
  -> verifier task with test receipts
  -> reviewed-OID promotion transaction
```

The first three stages can be queued and run by the resident daemon as they are implemented. Promotion remains deliberately absent until exact-OID compare-and-swap landing and recovery tests are complete.

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

Increasing concurrency means more simultaneous Codex/Claude processes and worktrees. Start with `2` for a solo workstation and raise it only when the repository and local model quotas can support more parallel work.
