# Automatic Agent team workflow

`agent-team team add` turns one explicit high-level request into a bounded software-team run. It does not let a model invent arbitrary roles, recursively spawn untracked children, merge Git refs, or write Project Brain assets.

## Fixed execution graph

```text
Planner (read-only, strict team.plan.v1)
  ├─ Builder (Codex by default, must create one clean candidate commit)
  ├─ Researcher (Claude by default, read-only bounded report)
  └─ Test (Codex by default, read-only test analysis)
             ↓ all three completed
          Reviewer (Claude by default, strict team.review.v1)
             ↓ completed
          Verifier (Codex by default, strict team.verify.v1)
             ↓ all children terminal
          Parent aggregate + one review delivery
```

The operator may route each fixed role to Codex or Claude. The Planner cannot add a deployer, merger, nested supervisor, or another arbitrary lane.

## Durable lifecycle

The Planner root is an ordinary fenced task. Its first attempt runs in a controller-owned worktree and must leave the worktree unchanged. After the plan passes schema and scope validation, `fanOutTask` performs one SQLite `BEGIN IMMEDIATE` transaction that:

1. verifies the parent `(task_id, worker, generation, claim_token, expiry)` fence;
2. validates the complete sibling DAG before writing anything;
3. inserts all five child tasks, lineage fields, dependencies, and signed events;
4. moves the parent to `waiting_children` and releases its worker slot.

Child tasks use the existing queue, leases, heartbeats, generation fencing, and daemon concurrency. When a child fails, queued descendants that depend on it fail with `dependency_failed` instead of remaining blocked forever. Once every direct child is terminal, the same transaction wakes the parent back to `queued`.

The parent's second claim does not launch another CLI. The controller reads the five durable child records, validates the exact Builder candidate and structured gates, derives `READY_FOR_HUMAN` or `CHANGES_REQUESTED`, completes the parent, and writes one bounded review-channel delivery.

## Failure recovery

If one lane fails, dependency propagation marks only its blocked descendants failed and wakes the parent for a deterministic aggregate. That aggregate fails while retaining the validated Planner result and the original child IDs.

An explicit retry of the failed team root reuses that durable DAG instead of running Planner or `fanOutTask` again. In one SQLite transaction the controller increments the parent generation, requeues only failed direct children, clears their stale result/error and lease fields, preserves completed siblings, and returns the parent to `waiting_children`. Existing dependency edges still gate Reviewer and Verifier. When the retried children settle, the parent is woken and aggregates the same lineage again.

If all children were already completed and only the aggregate failed, retry queues only the parent. Every retry remains generation-fenced and emits signed `task.retried` events plus a `task.team-recovery` summary for child recovery.

Any direct child in a non-terminal state keeps the parent in `waiting_children`; only failed children are reset. Recovery fails closed if lineage exists but the validated `result.plan` is missing, and `fanOutTask` refuses every second lineage write for a parent that already has children.

## Output contracts

- `team.plan.v1` contains one summary, bounded assumptions, 1-12 acceptance criteria, exactly three planning lanes, and 1-12 unique required checks.
- `team.review.v1` contains `APPROVED` or `CHANGES_REQUESTED` plus bounded findings. High and critical findings require proof.
- `team.verify.v1` contains `PASS` or `FAIL`, a bounded summary, and unique check receipts. A `PASS` must cover every Planner-required check with a matching `PASS` receipt.

JSON must be the entire final response: no Markdown fence, prose wrapper, unknown keys, or extra roles. Invalid output fails the claimed task.

Research and test reports are plain text capped at 12 KiB. Handoffs are controller-selected, allowlisted projections capped at 12 KiB. They are labeled untrusted and cannot override scope, controller rules, or the next role's output schema.

## Git and scope rules

- Every Agent receives an independent worktree and branch derived from task ID and generation.
- Planner, Researcher, Test, Reviewer, and Verifier are read-only. A changed commit OID fails the task.
- Builder must leave a clean worktree with a candidate OID different from its exact base OID.
- Reviewer and Verifier start from the Builder's exact candidate OID, not a mutable branch name.
- Child scopes cannot expand the operator's root scope. Empty report scopes inherit a non-empty root scope.
- No stage merges, rebases, pushes, deletes a branch, deletes a worktree, or updates the protected ref.

## Current boundary

This release automatically decomposes work only after an operator explicitly submits a team task. It does not yet:

- invent its own backlog or continuously decide what to improve;
- persist a separate attempt/session table beyond task generations and signed runtime events;
- inspect native subagents spawned inside a Codex or Claude process;
- merge parallel code-producing lanes;
- run controller-owned allowlisted shell checks independently of the Verifier CLI;
- land or push the verified candidate;
- extract Agent output into Project Brain.

Those boundaries keep the first executable team slice observable, recoverable, and reversible.
