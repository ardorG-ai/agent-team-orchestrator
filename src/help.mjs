export const HELP = `Agent Team Orchestrator v0.2.0-dev.1

Usage:
  agent-team init [--repo PATH] [--state-root PATH] [--json]
  agent-team doctor [--repo PATH] [--state-root PATH] [--json]
  agent-team gui [--repo PATH] [--state-root PATH] [--host 127.0.0.1] [--port 4317]
  agent-team daemon [--repo PATH] [--state-root PATH] [--host 127.0.0.1] [--port 4317]
                    [--poll-ms N] [--lease-ms N] [--timeout-ms N] [--concurrency N]

  agent-team task add --title TEXT [--description TEXT] [--adapter codex|claude]
                      [--depends ID[,ID...]] [--scope PATH[,PATH...]]
                      [--base REF] [--channel CHANNEL] [--role ROLE]
                      --idempotency-key KEY
  agent-team team add --title TEXT [--description TEXT] [--adapter codex|claude]
                      [--depends ID[,ID...]] [--scope PATH[,PATH...]]
                      [--base REF] [--channel CHANNEL]
                      [--builder-adapter codex|claude] [--researcher-adapter codex|claude]
                      [--test-adapter codex|claude] [--reviewer-adapter codex|claude]
                      [--verifier-adapter codex|claude] --idempotency-key KEY
  agent-team task list [--status STATUS] [--json]
  agent-team task show TASK_ID [--json]
  agent-team task claim --worker WORKER [--task TASK_ID] [--lease-ms N] [--json]
  agent-team task heartbeat TASK_ID --worker WORKER --generation N --claim-token TOKEN
                            [--lease-ms N] [--json]
  agent-team task complete TASK_ID --worker WORKER --generation N --claim-token TOKEN
                           [--result JSON] [--json]
  agent-team task fail TASK_ID --worker WORKER --generation N --claim-token TOKEN
                       --error TEXT [--retryable true|false] [--json]
  agent-team task retry TASK_ID --generation N [--reason TEXT] [--json]

  agent-team channel set CHANNEL --capacity N [--json]
  agent-team channel list [--json]
  agent-team outbox enqueue --channel CHANNEL --idempotency-key KEY --payload JSON
                             [--task TASK_ID --worker WORKER --generation N --claim-token TOKEN]
                             [--capacity N] [--json]
  agent-team outbox claim --channel CHANNEL --consumer CONSUMER [--limit N]
                          [--visibility-ms N] [--json]
  agent-team outbox ack MESSAGE_ID --consumer CONSUMER --generation N --lease-token TOKEN [--json]
  agent-team outbox nack MESSAGE_ID --consumer CONSUMER --generation N --lease-token TOKEN [--json]

  agent-team worktree prepare TASK_ID --worker WORKER --generation N --claim-token TOKEN
                              [--base OID] [--json]
  agent-team worktree snapshot TASK_ID --worker WORKER --generation N --claim-token TOKEN [--json]

  agent-team asset add --key KEY --kind memory|skill|knowledge --title TEXT
                       (--content TEXT | --content-file PATH)
                       [--layer l1|l2|l3] [--source JSON] [--expected-revision N] [--json]
  agent-team asset list [--kind memory|skill|knowledge] [--key-prefix PREFIX]
                        [--limit N] [--json]
  agent-team asset show ASSET_ID [--json]

  agent-team loadout create --key KEY --role ROLE --asset ASSET_ID[:MODE[:PRIORITY]]
                            [--asset ASSET_ID[:MODE[:PRIORITY]] ...]
                            [--byte-budget N] [--expected-revision N] [--json]
  agent-team loadout bind --role ROLE --loadout LOADOUT_ID
                          [--expected-current LOADOUT_ID | --expect-unbound true|false] [--json]
  agent-team loadout list [--role ROLE] [--limit N] [--json]
  agent-team loadout show --role ROLE [--json]

  agent-team worker run --worker WORKER [--task TASK_ID] [--adapter codex|claude]
                        [--lease-ms N] [--timeout-ms N] [--review-channel CHANNEL] [--json]

  agent-team events tail [--limit N] [--json]
  agent-team events verify [--json]

Safety:
  The GUI binds to loopback only and keeps worker fences inside the controller.
  The daemon binds to loopback only, reuses runWorkerOnce as the sole execution boundary,
  and stops gracefully on SIGINT/SIGTERM without auto-merging or cleaning up worktrees.
  The current release does not merge, update target refs, delete worktrees, or delete branches.

Project Brain:
  Asset kinds are memory, skill, and knowledge. --layer only applies to memory assets.
  Loadout asset modes are direct, summary, reference, and tool. Omitted mode defaults to direct.
  Omitted loadout priority preserves listed order by assigning higher priority to earlier entries.

Agent teams:
  team add creates a Planner root task. The Planner atomically expands it into bounded Builder,
  Researcher, Test, Reviewer, and Verifier child tasks; adapter overrides control each role.
`;
