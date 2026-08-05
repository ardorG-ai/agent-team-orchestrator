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

## Local GUI boundary

The GUI server binds only to loopback, rejects unexpected `Host` values, applies a restrictive content security policy, requires same-origin mutations, caps JSON request bodies, and requires an ephemeral per-process mutation capability. The capability is delivered in the printed launch URL fragment, is not returned by the HTTP server, is kept only for the browser tab session, and is removed from the address bar after bootstrap. Claim and lease tokens are recursively removed from API responses.

Read endpoints are intentionally unauthenticated on loopback and expose project/task projections, including local repository and worktree paths. This is acceptable only under the single trusted local-operator model.

These controls protect against accidental exposure, drive-by browser requests, and simple loopback probing; they are not an operating-system sandbox against a malicious process already running as the same user. Agent subprocesses are not handed the mutation capability through prompts or environment variables, but a hostile same-account process able to inspect the operator's browser or terminal is outside the v0.1 isolation guarantee. Run the controller only on a trusted local account and do not treat loopback as a multi-user security boundary.

## Executable trust boundary

The current release resolves `git`, `codex`, and `claude` from the trusted operator environment and then executes the resolved absolute paths. `agent-team doctor` reports those paths. v0.1 does not attest or pin binary hashes across invocations, so it must not be started with a `PATH` supplied by an untrusted repository, shell hook, or package script.
