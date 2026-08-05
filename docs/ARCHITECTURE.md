# Architecture

## Control-plane rule

SQLite is the sole authority. Worktrees, child processes, output files, and terminal streams are projections of state and may be discarded or reconstructed. No filesystem artifact may silently override the database.

## Planes

```text
CLI
  -> Project context and policy
  -> SQLite control plane
       - Task DAG
       - Lease and fencing state
       - Bounded outbox
       - Signed hash-chain event log
       - Worktree and run receipts
  -> Runtime adapters
       - Codex CLI
       - Claude Code CLI
  -> Controller-owned Git worktrees
```

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

## v0.1 non-goals

- Multi-user or multi-host operation
- Remote brokers or databases
- Automatic Git landing or pushing
- Automatic worktree/branch deletion
- Long-term semantic memory
- Web UI
- Arbitrary third-party Agent adapters
