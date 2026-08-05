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

The current branch has no command that removes a worktree, deletes a branch, force-resets a ref, or merges into `main`. These operations will only be introduced with exact-OID compare-and-swap checks and dedicated regression tests.

## Project Brain write boundary

Project Brain is a controller-governed store, not a model-writable scratchpad.

- Workers may consume resolved loadouts as bounded reference material.
- Workers do not directly create assets, create loadouts, or bind active loadouts from model output.
- Raw model output must not be auto-promoted into project assets, summaries, or role bindings.
- Project Brain is not a secret store. `direct` and `summary` entries place asset text into worker prompts, and a model may restate that text in its final output.
- `direct` and `summary` are for trusted, operator-curated guidance. Arbitrary external Markdown, copied model output, and unreviewed documents belong behind `reference` or `tool` locators instead of inline prompt context.
- `reference` and `tool` entries inject only constrained locator metadata such as `source` objects; the full source body does not enter the prompt through those modes.
- Audit records store non-body identifiers such as ID/key/revision/hash/role for Project Brain mutations and prompt-injection receipts, not full memory bodies, `source` payloads, or loadout `entries`. Runtime audit events retain status/session metadata but omit Agent final messages and terminal messages, which may repeat prompt-visible assets.

This is the key constraint that keeps prompt injection, hallucinated memory, and runaway self-editing from turning into durable control-plane state.

## Team orchestration boundary

- Only a fenced controller transaction may create parent/child lineage. Ordinary `createTask` calls are root-only.
- Planner output selects bounded objectives and scopes inside a controller-fixed five-child graph; it cannot add roles or arbitrary dependencies.
- A non-empty operator scope is an upper bound. Empty Researcher/Test scopes inherit it instead of expanding to the repository.
- Planner, Researcher, Test, Reviewer, and Verifier worktrees are read-only at the Git snapshot boundary.
- Reviewer and Verifier resolve the exact completed Builder candidate OID through the store and must belong to the same parent.
- Handoffs expose only allowlisted result fields, are capped at 12 KiB, and are labeled untrusted in the receiving prompt.
- Reviewer/Verifier JSON rejects unknown fields. A verification `PASS` must contain every required check as a unique passing receipt.
- Failed dependencies terminalize queued descendants; a failed lane cannot silently leave the parent waiting forever.
- The final team verdict is derived by controller code. Agent text cannot directly mark the parent ready or update a Git ref.

## Auth reuse

Codex and Claude adapters may reuse the operator's existing CLI authentication through an explicit, narrow environment/config allowlist. The orchestrator never copies credentials into its database, event log, task prompt, or artifacts.

## Local GUI boundary

The GUI server binds only to loopback, rejects unexpected `Host` values, applies a restrictive content security policy, requires same-origin mutations, caps JSON request bodies, and requires an ephemeral per-process mutation capability. The capability is delivered in the printed launch URL fragment, is not returned by the HTTP server, is kept only for the browser tab session, and is removed from the address bar after bootstrap. Claim and lease tokens are recursively removed from API responses.

Read endpoints are intentionally unauthenticated on loopback and expose project/task projections, including local repository and worktree paths. This is acceptable only under the single trusted local-operator model.

These controls protect against accidental exposure, drive-by browser requests, and simple loopback probing; they are not an operating-system sandbox against a malicious process already running as the same user. Agent subprocesses are not handed the mutation capability through prompts or environment variables, but a hostile same-account process able to inspect the operator's browser or terminal is outside the current isolation guarantee. Run the controller only on a trusted local account and do not treat loopback as a multi-user security boundary.

## Executable trust boundary

The current release resolves `git`, `codex`, and `claude` from the trusted operator environment and then executes the resolved absolute paths. `agent-team doctor` reports those paths. The current branch does not attest or pin binary hashes across invocations, so it must not be started with a `PATH` supplied by an untrusted repository, shell hook, or package script.
