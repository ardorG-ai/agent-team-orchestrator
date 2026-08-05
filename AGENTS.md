# Agent Team Orchestrator contributor contract

This repository implements a local control plane for Codex CLI and Claude Code CLI.

## Non-negotiable invariants

- SQLite is the only authoritative control-plane state store.
- Every post-claim mutation must match `(task_id, generation, claim_token)`.
- State transitions, audit events, and required outbox messages commit in one transaction.
- Child processes use argument arrays with `shell: false`; prompts travel over stdin.
- Git work starts from an exact commit OID in a controller-owned worktree.
- v0.1 never automatically merges, deletes a worktree, or deletes a branch.
- Raw model output is untrusted data and never becomes a control field without validation.
- Event signing keys never enter child-process environments.

## Verification

Run before committing:

```bash
npm test
npm run check
```

Use real temporary Git repositories for worktree tests and real SQLite transactions for lease/fencing tests.

## Branch lifecycle

- `main` is the last verified stable baseline.
- `dev` is the self-iteration branch.
- Changes move from `dev` to `main` only after independent review and verification.

## Commit messages

Use the Lore format from the workspace contract: intent-first subject, followed by useful decision and verification trailers.
