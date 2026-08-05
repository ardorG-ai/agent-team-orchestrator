export const HELP = `Agent Team Orchestrator v0.1

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

  agent-team worker run --worker WORKER [--task TASK_ID] [--adapter codex|claude]
                        [--lease-ms N] [--timeout-ms N] [--review-channel CHANNEL] [--json]

  agent-team events tail [--limit N] [--json]
  agent-team events verify [--json]

Safety:
  The GUI binds to loopback only and keeps worker fences inside the controller.
  The daemon binds to loopback only, reuses runWorkerOnce as the sole execution boundary,
  and stops gracefully on SIGINT/SIGTERM without auto-merging or cleaning up worktrees.
  v0.1 does not merge, update target refs, delete worktrees, or delete branches.
`;
