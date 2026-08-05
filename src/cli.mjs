import {
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

import {
  booleanFlag,
  flag,
  integerFlag,
  listFlag,
  parseArgv,
} from './argv.mjs';
import { runDoctor } from './doctor.mjs';
import { AgentTeamError, errorPayload } from './errors.mjs';
import { HELP } from './help.mjs';
import { runWorkerOnce } from './orchestrator.mjs';
import { safeText, writeResult } from './output.mjs';
import {
  ensureGitRepository,
  projectContext,
} from './project-context.mjs';
import { openProjectStore } from './project-store.mjs';
import {
  createWorktree,
  deriveBranchName,
  resolveCommitOid,
  snapshotWorktree,
} from './worktree.mjs';

const DEFAULT_CHANNELS = Object.freeze([
  { channel: 'builder', capacity: 64 },
  { channel: 'control', capacity: 256 },
  { channel: 'review', capacity: 64 },
]);

function scalarFlag(parsed, name, fallback = undefined) {
  const value = flag(parsed, name, fallback);
  if (Array.isArray(value)) {
    throw new AgentTeamError('invalid_argument', `--${name} may only be supplied once`);
  }
  return value;
}

function optionalStringFlag(parsed, name, fallback = undefined) {
  const value = scalarFlag(parsed, name, fallback);
  if (value === undefined || value === true) return fallback;
  return String(value);
}

function requiredStringFlag(parsed, name) {
  const value = scalarFlag(parsed, name);
  if (value === undefined || value === true || value === '') {
    throw new AgentTeamError('missing_argument', `--${name} is required`);
  }
  return String(value);
}

function requiredIntegerFlag(parsed, name, options = {}) {
  requiredStringFlag(parsed, name);
  return integerFlag(parsed, name, undefined, options);
}

function requiredPositional(parsed, index, label) {
  const value = parsed.positionals[index];
  if (!value) {
    throw new AgentTeamError('missing_argument', `${label} is required`);
  }
  return value;
}

function parseJsonValue(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new AgentTeamError('invalid_json', `${label} must be valid JSON`, {
      cause: error.message,
    });
  }
}

function jsonFlag(parsed, name, fallback = undefined) {
  const raw = scalarFlag(parsed, name);
  if (raw === undefined) return fallback;
  if (raw === true || raw === '') {
    throw new AgentTeamError('missing_argument', `--${name} requires a JSON value`);
  }
  return parseJsonValue(String(raw), `--${name}`);
}

function adapterFlag(parsed, fallback = 'codex') {
  const adapter = optionalStringFlag(parsed, 'adapter', fallback);
  if (!['codex', 'claude'].includes(adapter)) {
    throw new AgentTeamError('invalid_argument', '--adapter must be codex or claude');
  }
  return adapter;
}

function publicContext(context) {
  return {
    repoRoot: context.repoRoot,
    gitCommonDir: context.gitCommonDir,
    repoId: context.repoId,
    stateRoot: context.stateRoot,
    projectDir: context.projectDir,
    worktreeRoot: context.worktreeRoot,
    artifactRoot: context.artifactRoot,
    dbPath: context.dbPath,
  };
}

function contextOptions(parsed) {
  const stateRoot = optionalStringFlag(parsed, 'state-root');
  return stateRoot ? { stateRoot } : {};
}

function repositoryPath(parsed, cwd) {
  return optionalStringFlag(parsed, 'repo', cwd);
}

async function withProjectStore(parsed, dependencies, callback) {
  const context = dependencies.projectContextFn(
    repositoryPath(parsed, dependencies.cwd),
    contextOptions(parsed),
  );
  const store = dependencies.openProjectStoreFn({
    dbPath: context.dbPath,
    secretKeyPath: context.keyPath,
  });

  try {
    return await callback({ context, store });
  } finally {
    store.close();
  }
}

function fenceFromFlags(parsed) {
  return {
    worker: requiredStringFlag(parsed, 'worker'),
    generation: requiredIntegerFlag(parsed, 'generation', { min: 1 }),
    claimToken: requiredStringFlag(parsed, 'claim-token'),
  };
}

function normalizeEvent(row) {
  return {
    seq: row.seq,
    occurredAt: row.occurred_at,
    kind: row.kind,
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: JSON.parse(row.payload_json),
    prevHash: row.prev_hash,
    entryHash: row.entry_hash,
    signature: row.signature,
  };
}

function readManagedWorktree(context, taskId, generation) {
  const branchName = deriveBranchName(taskId, generation);
  const markerPath = path.join(context.worktreeRoot, '.markers', `${branchName}.json`);
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch (error) {
    throw new AgentTeamError('worktree_receipt_missing', `Cannot read managed worktree receipt for ${taskId}`, {
      markerPath,
      cause: error.message,
    });
  }

  if (marker.branchName !== branchName || typeof marker.worktreePath !== 'string') {
    throw new AgentTeamError('invalid_worktree_receipt', 'Managed worktree receipt does not match the task attempt');
  }

  const root = realpathSync(context.worktreeRoot);
  const worktreePath = realpathSync(marker.worktreePath);
  const relative = path.relative(root, worktreePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AgentTeamError('unsafe_worktree_path', 'Managed worktree receipt escapes the configured root');
  }

  if (marker.commonDir !== context.gitCommonDir) {
    throw new AgentTeamError('repository_mismatch', 'Managed worktree receipt belongs to a different repository');
  }

  return { ...marker, markerPath, worktreePath };
}

function taskPayload(parsed, baseOid) {
  for (const deferredFlag of ['priority', 'max-attempts']) {
    if (scalarFlag(parsed, deferredFlag) !== undefined) {
      throw new AgentTeamError(
        'unsupported_argument',
        `--${deferredFlag} is not enforced in v0.1 and is intentionally unavailable`,
      );
    }
  }

  const dependencies = listFlag(parsed, 'depends');
  const scope = listFlag(parsed, 'scope');
  const description = optionalStringFlag(parsed, 'description', '');

  return {
    adapter: adapterFlag(parsed),
    baseOid,
    channel: optionalStringFlag(parsed, 'channel', 'review'),
    dependencies,
    description,
    role: optionalStringFlag(parsed, 'role', 'builder'),
    scope,
    title: requiredStringFlag(parsed, 'title'),
  };
}

function commandKey(parsed) {
  return parsed.positionals.slice(0, 2).join(' ');
}

export async function executeCli(argv, options = {}) {
  const dependencies = {
    cwd: options.cwd ?? process.cwd(),
    createWorktreeFn: options.createWorktreeFn ?? createWorktree,
    ensureGitRepositoryFn: options.ensureGitRepositoryFn ?? ensureGitRepository,
    openProjectStoreFn: options.openProjectStoreFn ?? openProjectStore,
    projectContextFn: options.projectContextFn ?? projectContext,
    resolveCommitOidFn: options.resolveCommitOidFn ?? resolveCommitOid,
    runDoctorFn: options.runDoctorFn ?? runDoctor,
    runWorkerOnceFn: options.runWorkerOnceFn ?? runWorkerOnce,
    snapshotWorktreeFn: options.snapshotWorktreeFn ?? snapshotWorktree,
  };
  const parsed = parseArgv(argv);

  if (booleanFlag(parsed, 'help') || parsed.positionals[0] === 'help') {
    return HELP;
  }
  if (booleanFlag(parsed, 'version') || parsed.positionals[0] === 'version') {
    return '0.1.1';
  }

  const command = commandKey(parsed);

  if (parsed.positionals[0] === 'init') {
    const repoRoot = dependencies.ensureGitRepositoryFn(repositoryPath(parsed, dependencies.cwd));
    const context = dependencies.projectContextFn(repoRoot, contextOptions(parsed));
    const store = dependencies.openProjectStoreFn({
      dbPath: context.dbPath,
      secretKeyPath: context.keyPath,
    });

    try {
      for (const channel of DEFAULT_CHANNELS) {
        if (!store.getChannel(channel.channel)) store.configureChannel(channel);
      }
      return {
        ok: true,
        initialized: true,
        context: publicContext(context),
        channels: store.listChannels(),
      };
    } finally {
      store.close();
    }
  }

  if (parsed.positionals[0] === 'doctor') {
    return withProjectStore(parsed, dependencies, async ({ context, store }) => (
      dependencies.runDoctorFn(context, store)
    ));
  }

  if (command === 'task add') {
    return withProjectStore(parsed, dependencies, async ({ context, store }) => {
      const requestedBase = optionalStringFlag(parsed, 'base', 'HEAD');
      const baseOid = await dependencies.resolveCommitOidFn(context.repoRoot, requestedBase);
      const payload = taskPayload(parsed, baseOid);
      return store.createTask({
        key: requiredStringFlag(parsed, 'idempotency-key'),
        payload,
        dependencies: payload.dependencies,
      });
    });
  }

  if (command === 'task list') {
    return withProjectStore(parsed, dependencies, async ({ store }) => store.listTasks({
      state: optionalStringFlag(parsed, 'status'),
      worker: optionalStringFlag(parsed, 'worker'),
      keyPrefix: optionalStringFlag(parsed, 'key-prefix'),
      limit: integerFlag(parsed, 'limit', 100, { min: 1, max: 10_000 }),
    }));
  }

  if (command === 'task show') {
    return withProjectStore(parsed, dependencies, async ({ store }) => {
      const taskId = requiredPositional(parsed, 2, 'TASK_ID');
      const task = store.getTask(taskId);
      if (!task) throw new AgentTeamError('task_not_found', `Task not found: ${taskId}`, undefined, 2);
      return task;
    });
  }

  if (command === 'task claim') {
    return withProjectStore(parsed, dependencies, async ({ store }) => {
      store.requeueExpiredTasks();
      return store.claimTask({
        worker: requiredStringFlag(parsed, 'worker'),
        taskId: optionalStringFlag(parsed, 'task'),
        ttlMs: integerFlag(parsed, 'lease-ms', 30_000, { min: 1 }),
      });
    });
  }

  if (command === 'task heartbeat') {
    return withProjectStore(parsed, dependencies, async ({ store }) => store.heartbeatTask({
      taskId: requiredPositional(parsed, 2, 'TASK_ID'),
      ...fenceFromFlags(parsed),
      ttlMs: integerFlag(parsed, 'lease-ms', 30_000, { min: 1 }),
    }));
  }

  if (command === 'task complete') {
    return withProjectStore(parsed, dependencies, async ({ store }) => store.completeTask({
      taskId: requiredPositional(parsed, 2, 'TASK_ID'),
      ...fenceFromFlags(parsed),
      result: jsonFlag(parsed, 'result', null),
    }));
  }

  if (command === 'task fail') {
    return withProjectStore(parsed, dependencies, async ({ store }) => store.failTask({
      taskId: requiredPositional(parsed, 2, 'TASK_ID'),
      ...fenceFromFlags(parsed),
      error: {
        message: requiredStringFlag(parsed, 'error'),
        retryable: booleanFlag(parsed, 'retryable'),
      },
    }));
  }

  if (command === 'task retry' || command === 'task requeue') {
    return withProjectStore(parsed, dependencies, async ({ store }) => {
      const taskId = requiredPositional(parsed, 2, 'TASK_ID');
      const expectedGeneration = requiredIntegerFlag(parsed, 'generation', { min: 0 });
      const retried = store.retryFailedTask({
        taskId,
        expectedGeneration,
        reason: optionalStringFlag(parsed, 'reason', null),
      });
      if (!retried) {
        throw new AgentTeamError('retry_conflict', `Task ${taskId} is not failed at generation ${expectedGeneration}`);
      }
      return retried;
    });
  }

  if (command === 'channel set') {
    return withProjectStore(parsed, dependencies, async ({ store }) => store.configureChannel({
      channel: requiredPositional(parsed, 2, 'CHANNEL'),
      capacity: requiredIntegerFlag(parsed, 'capacity', { min: 1 }),
    }));
  }

  if (command === 'channel list') {
    return withProjectStore(parsed, dependencies, async ({ store }) => store.listChannels());
  }

  if (command === 'outbox enqueue') {
    return withProjectStore(parsed, dependencies, async ({ store }) => {
      const taskId = optionalStringFlag(parsed, 'task');
      const hasFence = taskId !== undefined
        || flag(parsed, 'worker') !== undefined
        || flag(parsed, 'generation') !== undefined
        || flag(parsed, 'claim-token') !== undefined;
      const fence = hasFence ? { taskId, ...fenceFromFlags(parsed) } : {};
      if (hasFence && !taskId) throw new AgentTeamError('missing_argument', '--task is required for a fenced outbox write');

      const capacityRaw = scalarFlag(parsed, 'capacity');
      return store.enqueueOutbox({
        channel: requiredStringFlag(parsed, 'channel'),
        messageId: requiredStringFlag(parsed, 'idempotency-key'),
        payload: jsonFlag(parsed, 'payload'),
        capacity: capacityRaw === undefined
          ? undefined
          : integerFlag(parsed, 'capacity', undefined, { min: 1 }),
        ...fence,
      });
    });
  }

  if (command === 'outbox claim') {
    return withProjectStore(parsed, dependencies, async ({ store }) => store.claimOutbox({
      channel: requiredStringFlag(parsed, 'channel'),
      consumer: requiredStringFlag(parsed, 'consumer'),
      limit: integerFlag(parsed, 'limit', 1, { min: 1, max: 1_000 }),
      leaseMs: integerFlag(parsed, 'visibility-ms', 30_000, { min: 1 }),
    }));
  }

  if (command === 'outbox ack' || command === 'outbox nack') {
    return withProjectStore(parsed, dependencies, async ({ store }) => {
      const operation = command === 'outbox ack' ? store.ackOutbox : store.nackOutbox;
      return operation({
        messageId: requiredPositional(parsed, 2, 'MESSAGE_ID'),
        consumer: requiredStringFlag(parsed, 'consumer'),
        generation: requiredIntegerFlag(parsed, 'generation', { min: 1 }),
        leaseToken: requiredStringFlag(parsed, 'lease-token'),
      });
    });
  }

  if (command === 'worktree prepare') {
    return withProjectStore(parsed, dependencies, async ({ context, store }) => {
      const taskId = requiredPositional(parsed, 2, 'TASK_ID');
      const fence = fenceFromFlags(parsed);
      const task = store.getTask(taskId);
      if (!task) throw new AgentTeamError('task_not_found', `Task not found: ${taskId}`, undefined, 2);
      const allowed = store.appendTaskEvent({
        taskId,
        ...fence,
        type: 'worktree.prepare-requested',
      });
      if (!allowed) throw new AgentTeamError('stale_claim', 'Task claim is no longer current');

      const created = await dependencies.createWorktreeFn({
        repoPath: context.repoRoot,
        worktreeRoot: context.worktreeRoot,
        task: taskId,
        generation: fence.generation,
        ref: optionalStringFlag(parsed, 'base', task.payload?.baseOid ?? 'HEAD'),
      });
      const recorded = store.appendTaskEvent({
        taskId,
        ...fence,
        type: 'worktree.prepared',
        payload: created,
      });
      if (!recorded) throw new AgentTeamError('stale_claim', 'Task claim expired while preparing the worktree');
      return created;
    });
  }

  if (command === 'worktree snapshot') {
    return withProjectStore(parsed, dependencies, async ({ context, store }) => {
      const taskId = requiredPositional(parsed, 2, 'TASK_ID');
      const fence = fenceFromFlags(parsed);
      const receipt = readManagedWorktree(context, taskId, fence.generation);
      const allowed = store.appendTaskEvent({
        taskId,
        ...fence,
        type: 'worktree.snapshot-requested',
      });
      if (!allowed) throw new AgentTeamError('stale_claim', 'Task claim is no longer current');
      const snapshot = await dependencies.snapshotWorktreeFn({ worktreePath: receipt.worktreePath });
      const recorded = store.appendTaskEvent({
        taskId,
        ...fence,
        type: 'worktree.snapshotted',
        payload: snapshot,
      });
      if (!recorded) throw new AgentTeamError('stale_claim', 'Task claim expired while snapshotting the worktree');
      return snapshot;
    });
  }

  if (command === 'worker run') {
    return withProjectStore(parsed, dependencies, async ({ context, store }) => dependencies.runWorkerOnceFn({
      store,
      context,
      worker: requiredStringFlag(parsed, 'worker'),
      taskId: optionalStringFlag(parsed, 'task'),
      adapter: optionalStringFlag(parsed, 'adapter'),
      leaseMs: integerFlag(parsed, 'lease-ms', 30_000, { min: 100 }),
      timeoutMs: integerFlag(parsed, 'timeout-ms', 30 * 60_000, { min: 1 }),
      reviewChannel: optionalStringFlag(parsed, 'review-channel', 'review'),
    }));
  }

  if (command === 'events tail') {
    return withProjectStore(parsed, dependencies, async ({ store }) => {
      const limit = integerFlag(parsed, 'limit', 50, { min: 1, max: 10_000 });
      return store.listEventLog().slice(-limit).map(normalizeEvent);
    });
  }

  if (command === 'events verify') {
    return withProjectStore(parsed, dependencies, async ({ store }) => {
      const database = store.integrityCheck();
      const eventLog = store.verifyEventLog();
      return {
        ok: database === 'ok' && eventLog.ok,
        database,
        eventLog,
      };
    });
  }

  throw new AgentTeamError(
    'unknown_command',
    parsed.positionals.length === 0
      ? 'A command is required. Run agent-team --help.'
      : `Unknown command: ${parsed.positionals.join(' ')}`,
    undefined,
    2,
  );
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const json = (() => {
    try {
      return booleanFlag(parseArgv(argv), 'json');
    } catch {
      return argv.includes('--json');
    }
  })();

  try {
    const result = await executeCli(argv, options);
    writeResult(result, { json });
    return 0;
  } catch (error) {
    const payload = errorPayload(error);
    if (json) {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      process.stderr.write(`${safeText(`${payload.error.code}: ${payload.error.message}`)}\n`);
    }
    return error instanceof AgentTeamError ? error.exitCode : 1;
  }
}

export default runCli;
