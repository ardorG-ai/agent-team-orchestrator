# Architecture

## Control-plane rule

SQLite is the sole authority. Worktrees, child processes, output files, and terminal streams are projections of state and may be discarded or reconstructed. No filesystem artifact may silently override the database.

## Planes

```text
CLI -----------------------+
                            |
Loopback GUI -> HTTP API --+-> Project context and policy
                            -> SQLite control plane
Resident daemon -----------+    - Task DAG
  - bounded worker slots         - Lease and fencing state
  - continuous queue polling     - Bounded outbox
  - graceful shutdown            - Signed hash-chain event log
                                  - Worktree and run receipts
                            -> Runtime adapters
                                 - Codex CLI
                                 - Claude Code CLI
                            -> Controller-owned Git worktrees
```

The GUI is a projection and mutation surface over the same store; it is not a second source of truth. The daemon owns long-lived scheduling and calls the existing `runWorkerOnce` boundary for every worker slot. GUI-triggered runs use that same boundary, so lease claiming and fencing remain centralized.

## Fencing tuple

Every successful claim returns:

```text
(task_id, generation, claim_token, lease_expires_at)
```

Heartbeat, completion, failure, task-scoped outbox writes, and worktree publication must match the current tuple. Reclaiming an expired task changes both generation and claim token, making all writes from the old process stale.

## Transactional outbox

A control-plane transition and its audit/outbox records are committed together. Producers never publish externally first and repair state afterward.

Channels are bounded. Capacity is checked inside the same write transaction used to enqueue. Full channels return explicit backpressure rather than dropping or overwriting messages.

## Audit chain

Events use canonical JSON, `prev_hash`, SHA-256, and HMAC-SHA256. A separately signed head tuple makes simple database truncation detectable. The signing key lives outside the Git repository with mode `0600` and is never placed in an Agent subprocess environment.

## Git model

Each attempt uses a branch and worktree derived from task ID and generation, created from an exact base commit OID. v0.1 can inspect and record a clean candidate commit but cannot merge, update the target ref, delete a branch, or delete a worktree.

## Adapter model

Adapters translate provider-specific streams into normalized events. Codex stdout is JSONL from `codex exec --json`; Claude stdout is stream JSON from `claude -p --verbose --output-format stream-json`. Stderr remains diagnostic data. Raw Agent text never controls task status or paths.

Only explicitly allowlisted environment keys can reach an adapter. Controller-owned values such as the worktree cwd, prompt, and abort signal cannot be overridden by adapter-specific options.

## GUI projection

The browser reads task, channel, outbox, run, and signed-event projections from a loopback-only HTTP server. Mutations require an ephemeral per-process capability passed in the launch URL fragment, which is not sent in HTTP requests and is removed from the address bar after bootstrap. Responses remove claim and lease tokens recursively before serialization.

Polling is deliberate in this version. SQLite remains authoritative, and reconnecting the page reconstructs the current view without relying on an in-browser event stream.

## Resident scheduler

`agent-team daemon` starts the GUI and one or more bounded worker loops in the same controller process. Each slot repeatedly calls `runWorkerOnce`, which atomically claims one ready task, prepares an exact-OID worktree, runs the selected adapter, snapshots the candidate, and publishes the review receipt. Manual GUI launches are disabled in daemon mode so they cannot bypass the configured concurrency budget.

An idle or failed attempt backs off for the configured poll interval. A completed attempt can immediately look for the next ready task. A failure in one slot is recorded and does not terminate the other slots or the GUI.

Shutdown is graceful: the GUI stops admitting manual runs, its active runs and the daemon worker slots settle within the configured Agent timeout, and only then does the SQLite store close. There is intentionally no merge, push, branch deletion, or worktree deletion in this path.

## v0.1 non-goals

- Multi-user or multi-host operation
- Remote brokers or databases
- Automatic Git landing or pushing
- Automatic worktree/branch deletion
- Long-term semantic memory
- Native desktop packaging, login-item installation, or OS service management
- Arbitrary third-party Agent adapters
