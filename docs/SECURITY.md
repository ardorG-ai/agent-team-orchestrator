# Security baseline

## Trust boundary

The local operator is trusted. Repositories, task text, model output, subprocesses, and stale workers are not.

## Required controls

- Use `spawn`/`execFile` with argument arrays and `shell: false`.
- Send prompts over stdin.
- Resolve mutable paths under one managed root and reject traversal or symlink roots.
- Never accept a filesystem path as deletion authority.
- Apply generation/token fencing to every post-claim write.
- Keep the event key outside worktrees with mode `0600`.
- Do not inherit unrelated cloud, SSH, GitHub, or browser credentials into Agent processes.
- Reject environment overrides that are not explicitly allowlisted for the selected adapter.
- Cap runtime, stdout, and stderr for every subprocess.
- Escape terminal control characters when displaying untrusted Agent output.
- Treat exact Git OIDs and repository identity as preconditions, not suggestions.

## Deliberately absent destructive behavior

v0.1 has no command that removes a worktree, deletes a branch, force-resets a ref, or merges into `main`. These operations will only be introduced with exact-OID compare-and-swap checks and dedicated regression tests.

## Auth reuse

Codex and Claude adapters may reuse the operator's existing CLI authentication through an explicit, narrow environment/config allowlist. The orchestrator never copies credentials into its database, event log, task prompt, or artifacts.

## Executable trust boundary

The current release resolves `git`, `codex`, and `claude` from the trusted operator environment and then executes the resolved absolute paths. `agent-team doctor` reports those paths. v0.1 does not attest or pin binary hashes across invocations, so it must not be started with a `PATH` supplied by an untrusted repository, shell hook, or package script.
