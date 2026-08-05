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
  - Project Brain writes         - Project Brain assets
  - bounded worker slots         - Lease and fencing state
  - fixed team fan-out/join      - Parent/child lineage
  - loadout resolution           - Role loadouts and bindings
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

Project Brain events use the same chain. Asset and loadout events record non-body identifiers such as `assetId`, `assetKey`, `loadoutId`, `loadoutKey`, `revision`, `role`, and `contentHash`, but not raw memory text, `source` bodies, or loadout `entries`. Prompt-injection receipts record exact loadout and asset hashes without replaying full injected text into the audit stream.

## Git model

Each attempt uses a branch and worktree derived from task ID and generation, created from an exact base commit OID. Team Reviewer and Verifier attempts resolve their base from the completed Builder task's exact candidate OID. The current branch can inspect and record a clean candidate commit but cannot merge, update the target ref, delete a branch, or delete a worktree.

## Project Brain model

Project Brain is a governed reference plane layered onto the same SQLite authority.

- `project_assets` stores versioned create-only assets keyed by operator intent.
- Assets are typed as `memory`, `skill`, or `knowledge`.
- Memory assets can be tagged `l1`, `l2`, or `l3`.
- `role_loadouts` stores versioned ordered asset references plus injection modes and byte budgets.
- `role_loadout_bindings` stores one active loadout per role through an explicit controller mutation.

At task-claim time the controller resolves the active loadout for `task.payload.role`, renders only bounded reference material, appends it after the required-behavior block, and records a `task.event.loadout-snapshot` receipt containing hashes, byte counts, and truncation metadata.

Project Brain is not a secret store. `direct` and `summary` entries copy asset text into the worker prompt, so that material may later appear in model-visible transcripts or final output. `reference` and `tool` entries inject only bounded locator metadata such as `source` objects, not the full body of the underlying knowledge source.

This remains narrower than autonomous memory or task invention. The controller does not derive assets from run output. It can execute a Planner-owned task graph only after the operator explicitly submits a team task; the graph shape and role set remain controller-fixed.

## Team workflow model

Team roots use the same task table and fencing tuple as standalone work. Schema v3 adds immutable `parent_task_id` and `slice_key` projections. Normal task creation is root-only: lineage can be written only inside the fenced `fanOutTask` transaction.

The parent transitions from `running` to `waiting_children` after all five children and sibling dependencies are durably visible. It holds no worker slot while waiting. Child completion and failure re-evaluate direct parents inside the same transaction. Failed dependencies recursively terminalize queued descendants so a failed Builder cannot leave Reviewer and Verifier rows blocked forever.

When the children settle, the parent returns to `queued`. Its second claim performs a deterministic database aggregate without launching a CLI or worktree. The controller validates the Builder candidate, Reviewer verdict, Verifier verdict, and required-check coverage before publishing one final review delivery.

See [Automatic Agent team workflow](TEAM-WORKFLOW.md).

## Adapter model

Adapters translate provider-specific streams into normalized events. Codex stdout is JSONL from `codex exec --json`; Claude stdout is stream JSON from `claude -p --verbose --output-format stream-json`. Stderr remains diagnostic data. Raw Agent text never controls task status or paths.

Only explicitly allowlisted environment keys can reach an adapter. Controller-owned values such as the worktree cwd, prompt, and abort signal cannot be overridden by adapter-specific options.

## GUI projection

The browser reads task, channel, outbox, run, and signed-event projections from a loopback-only HTTP server. Mutations require an ephemeral per-process capability passed in the launch URL fragment, which is not sent in HTTP requests and is removed from the address bar after bootstrap. Responses remove claim and lease tokens recursively before serialization.

Project Brain is exposed in this slice through read projections: project assets, role loadouts, role bindings, and the currently resolved role loadout can be inspected through the GUI server. Asset creation and loadout binding remain controller/CLI operations, not browser-authored flows.

Polling is deliberate in this version. SQLite remains authoritative, and reconnecting the page reconstructs the current view without relying on an in-browser event stream.

## Resident scheduler

`agent-team daemon` starts the GUI and one or more bounded worker loops in the same controller process. Each slot repeatedly calls `runWorkerOnce`, which atomically claims one ready task and dispatches either a standalone attempt, one team stage, or a deterministic settled-parent aggregate. Manual GUI launches are disabled in daemon mode so they cannot bypass the configured concurrency budget.

An idle or failed attempt backs off for the configured poll interval. A completed attempt can immediately look for the next ready task. A failure in one slot is recorded and does not terminate the other slots or the GUI.

Shutdown is graceful: the GUI stops admitting manual runs, its active runs and the daemon worker slots settle within the configured Agent timeout, and only then does the SQLite store close. There is intentionally no merge, push, branch deletion, or worktree deletion in this path.

## Current non-goals

- Multi-user or multi-host operation
- Remote brokers or databases
- Automatic Git landing or pushing
- Automatic worktree/branch deletion
- Autonomous task invention or an unbounded recursive Planner
- Arbitrary model-selected roles or DAG shapes
- Automatic memory extraction, summarization, or write-back from run output
- Long-term semantic memory beyond the governed create-only Project Brain slice
- Native desktop packaging, login-item installation, or OS service management
- Arbitrary third-party Agent adapters
