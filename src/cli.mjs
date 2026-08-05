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
import { startDaemon } from './daemon.mjs';
import { AgentTeamError, errorPayload } from './errors.mjs';
import { startGuiServer } from './gui-server.mjs';
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
const PROJECT_ASSET_KINDS = new Set(['memory', 'skill', 'knowledge']);
const PROJECT_MEMORY_LAYERS = new Set(['l1', 'l2', 'l3']);
const ROLE_LOADOUT_MODES = new Set(['direct', 'summary', 'reference', 'tool']);
const PROJECT_BRAIN_LIST_LIMIT_MAX = 1_000;

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

function optionalIntegerFlag(parsed, name, fallback = undefined, options = {}) {
  const raw = scalarFlag(parsed, name);
  if (raw === undefined) return fallback;
  if (raw === true || raw === '') {
    throw new AgentTeamError('missing_argument', `--${name} is required`);
  }
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

function enumFlag(parsed, name, allowedValues, fallback = undefined) {
  const raw = scalarFlag(parsed, name, undefined);
  if (raw === undefined) return fallback;
  if (raw === true || raw === '') {
    throw new AgentTeamError('missing_argument', `--${name} is required`);
  }
  const value = String(raw);
  if (!allowedValues.has(value)) {
    throw new AgentTeamError(
      'invalid_argument',
      `--${name} must be one of ${[...allowedValues].join('|')}`,
    );
  }
  return value;
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

function readUtf8File(cwd, filePath, label) {
  const resolvedPath = path.resolve(cwd, filePath);
  try {
    return readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    throw new AgentTeamError('file_read_error', `Cannot read ${label}: ${filePath}`, {
      cause: error.message,
      path: resolvedPath,
    });
  }
}

function requireStoreMethod(store, methodName, command) {
  if (typeof store[methodName] !== 'function') {
    throw new AgentTeamError(
      'unsupported_command',
      `${command} is not available in this build`,
      { methodName },
      2,
    );
  }
  return store[methodName].bind(store);
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
        `--${deferredFlag} is not enforced in the current release and is intentionally unavailable`,
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

function projectAssetContent(parsed, cwd) {
  const inlineContent = scalarFlag(parsed, 'content');
  const contentFile = scalarFlag(parsed, 'content-file');

  if (inlineContent !== undefined && contentFile !== undefined) {
    throw new AgentTeamError(
      'invalid_argument',
      '--content and --content-file are mutually exclusive',
    );
  }

  if (inlineContent === undefined && contentFile === undefined) {
    throw new AgentTeamError(
      'missing_argument',
      'either --content or --content-file is required',
    );
  }

  if (inlineContent !== undefined) {
    if (inlineContent === true || inlineContent === '') {
      throw new AgentTeamError('missing_argument', '--content is required');
    }
    return String(inlineContent);
  }

  const filePath = requiredStringFlag(parsed, 'content-file');
  return readUtf8File(cwd, filePath, '--content-file');
}

function parseLoadoutEntryToken(token, index, total) {
  const parts = String(token).split(':');
  if (parts.length < 1 || parts.length > 3 || parts[0] === '') {
    throw new AgentTeamError(
      'invalid_argument',
      `--asset value "${token}" must be ASSET_ID, ASSET_ID:MODE, or ASSET_ID:MODE:PRIORITY`,
    );
  }

  const [assetId, modeToken, priorityToken] = parts;
  const injectionMode = modeToken === undefined ? 'direct' : modeToken;
  if (!ROLE_LOADOUT_MODES.has(injectionMode)) {
    throw new AgentTeamError(
      'invalid_argument',
      `--asset value "${token}" uses unsupported mode "${injectionMode}"`,
    );
  }

  const priority = priorityToken === undefined
    ? total - index
    : Number(priorityToken);
  if (!Number.isSafeInteger(priority)) {
    throw new AgentTeamError(
      'invalid_argument',
      `--asset value "${token}" has an invalid priority`,
    );
  }

  return {
    assetId,
    injectionMode,
    priority,
  };
}

function loadoutEntries(parsed) {
  const assets = listFlag(parsed, 'asset');
  if (assets.length === 0) {
    throw new AgentTeamError('missing_argument', 'at least one --asset is required');
  }
  return assets.map((token, index) => parseLoadoutEntryToken(token, index, assets.length));
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
    startDaemonFn: options.startDaemonFn ?? startDaemon,
    startGuiServerFn: options.startGuiServerFn ?? startGuiServer,
  };
  const parsed = parseArgv(argv);

  if (booleanFlag(parsed, 'help') || parsed.positionals[0] === 'help') {
    return HELP;
  }
  if (booleanFlag(parsed, 'version') || parsed.positionals[0] === 'version') {
    return '0.2.0-dev.0';
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

  if (parsed.positionals[0] === 'gui') {
    const repoRoot = dependencies.ensureGitRepositoryFn(repositoryPath(parsed, dependencies.cwd));
    const context = dependencies.projectContextFn(repoRoot, contextOptions(parsed));
    const store = dependencies.openProjectStoreFn({
      dbPath: context.dbPath,
      secretKeyPath: context.keyPath,
    });

    let gui;
    try {
      for (const channel of DEFAULT_CHANNELS) {
        if (!store.getChannel(channel.channel)) store.configureChannel(channel);
      }
      gui = await dependencies.startGuiServerFn({
        context,
        host: optionalStringFlag(parsed, 'host', '127.0.0.1'),
        port: integerFlag(parsed, 'port', 4317, { min: 0, max: 65_535 }),
        store,
      });
    } catch (error) {
      store.close();
      throw error;
    }

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      try {
        await gui.close();
      } finally {
        store.close();
      }
    };
    const onSignal = () => {
      void close();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    const result = {
      host: gui.host,
      ok: true,
      port: gui.port,
      repoRoot: context.repoRoot,
      url: gui.launchUrl ?? gui.url,
    };
    Object.defineProperty(result, 'close', {
      enumerable: false,
      value: close,
    });
    return result;
  }

  if (parsed.positionals[0] === 'daemon') {
    const repoRoot = dependencies.ensureGitRepositoryFn(repositoryPath(parsed, dependencies.cwd));
    const context = dependencies.projectContextFn(repoRoot, contextOptions(parsed));
    const store = dependencies.openProjectStoreFn({
      dbPath: context.dbPath,
      secretKeyPath: context.keyPath,
    });

    let daemon;
    try {
      for (const channel of DEFAULT_CHANNELS) {
        if (!store.getChannel(channel.channel)) store.configureChannel(channel);
      }
      daemon = await dependencies.startDaemonFn({
        concurrency: integerFlag(parsed, 'concurrency', 1, { min: 1, max: 64 }),
        context,
        host: optionalStringFlag(parsed, 'host', '127.0.0.1'),
        leaseMs: integerFlag(parsed, 'lease-ms', 30_000, { min: 100, max: 60 * 60_000 }),
        pollMs: integerFlag(parsed, 'poll-ms', 1_000, { min: 50, max: 60_000 }),
        port: integerFlag(parsed, 'port', 4317, { min: 0, max: 65_535 }),
        runWorkerOnce: dependencies.runWorkerOnceFn,
        startGuiServer: dependencies.startGuiServerFn,
        store,
        timeoutMs: integerFlag(parsed, 'timeout-ms', 30 * 60_000, { min: 1, max: 24 * 60 * 60_000 }),
      });
    } catch (error) {
      store.close();
      throw error;
    }

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      try {
        await daemon.close();
      } finally {
        store.close();
      }
    };
    const onSignal = () => {
      void close();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    const result = {
      concurrency: daemon.status?.concurrency ?? integerFlag(parsed, 'concurrency', 1, { min: 1, max: 64 }),
      host: daemon.host,
      leaseMs: daemon.status?.leaseMs ?? integerFlag(parsed, 'lease-ms', 30_000, { min: 100, max: 60 * 60_000 }),
      ok: true,
      pollMs: daemon.status?.pollMs ?? integerFlag(parsed, 'poll-ms', 1_000, { min: 50, max: 60_000 }),
      port: daemon.port,
      repoRoot: context.repoRoot,
      timeoutMs: daemon.status?.timeoutMs
        ?? integerFlag(parsed, 'timeout-ms', 30 * 60_000, { min: 1, max: 24 * 60 * 60_000 }),
      url: daemon.url,
    };
    Object.defineProperty(result, 'close', {
      enumerable: false,
      value: close,
    });
    return result;
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

  if (command === 'asset add') {
    return withProjectStore(parsed, dependencies, async ({ store }) => {
      const createProjectAsset = requireStoreMethod(store, 'createProjectAsset', 'asset add');
      const kind = enumFlag(parsed, 'kind', PROJECT_ASSET_KINDS);
      const layer = enumFlag(parsed, 'layer', PROJECT_MEMORY_LAYERS, null);
      if (kind === undefined) {
        throw new AgentTeamError('missing_argument', '--kind is required');
      }
      if (kind !== 'memory' && layer !== null) {
        throw new AgentTeamError('invalid_argument', '--layer is only allowed when --kind=memory');
      }
      return createProjectAsset({
        assetKey: requiredStringFlag(parsed, 'key'),
        kind,
        memoryLayer: layer,
        title: requiredStringFlag(parsed, 'title'),
        contentText: projectAssetContent(parsed, dependencies.cwd),
        source: jsonFlag(parsed, 'source', null),
        expectedRevision: optionalIntegerFlag(parsed, 'expected-revision', 0, { min: 0 }),
      });
    });
  }

  if (command === 'asset list') {
    return withProjectStore(parsed, dependencies, async ({ store }) => {
      const listProjectAssets = requireStoreMethod(store, 'listProjectAssets', 'asset list');
      const limit = optionalIntegerFlag(parsed, 'limit', 100, {
        min: 1,
        max: PROJECT_BRAIN_LIST_LIMIT_MAX,
      });
      return listProjectAssets({
        keyPrefix: optionalStringFlag(parsed, 'key-prefix'),
        kind: enumFlag(parsed, 'kind', PROJECT_ASSET_KINDS),
        limit,
      });
    });
  }

  if (command === 'asset show') {
    return withProjectStore(parsed, dependencies, async ({ store }) => {
      const getProjectAsset = requireStoreMethod(store, 'getProjectAsset', 'asset show');
      const assetId = requiredPositional(parsed, 2, 'ASSET_ID');
      const asset = getProjectAsset(assetId);
      if (!asset) throw new AgentTeamError('asset_not_found', `Project asset not found: ${assetId}`, undefined, 2);
      return asset;
    });
  }

  if (command === 'loadout create') {
    return withProjectStore(parsed, dependencies, async ({ store }) => {
      const createRoleLoadout = requireStoreMethod(store, 'createRoleLoadout', 'loadout create');
      return createRoleLoadout({
        loadoutKey: requiredStringFlag(parsed, 'key'),
        role: requiredStringFlag(parsed, 'role'),
        entries: loadoutEntries(parsed),
        byteBudget: optionalIntegerFlag(parsed, 'byte-budget', undefined, { min: 1 }),
        expectedRevision: optionalIntegerFlag(parsed, 'expected-revision', 0, { min: 0 }),
      });
    });
  }

  if (command === 'loadout bind') {
    return withProjectStore(parsed, dependencies, async ({ store }) => {
      const bindRoleLoadout = requireStoreMethod(store, 'bindRoleLoadout', 'loadout bind');
      const expectedCurrentLoadoutId = optionalStringFlag(parsed, 'expected-current');
      const expectUnboundRaw = scalarFlag(parsed, 'expect-unbound');
      if (expectedCurrentLoadoutId !== undefined && expectUnboundRaw !== undefined) {
        throw new AgentTeamError(
          'invalid_argument',
          '--expected-current and --expect-unbound are mutually exclusive',
        );
      }

      const expectUnbound = expectUnboundRaw === undefined
        ? undefined
        : booleanFlag(parsed, 'expect-unbound');
      return bindRoleLoadout({
        role: requiredStringFlag(parsed, 'role'),
        loadoutId: requiredStringFlag(parsed, 'loadout'),
        ...(expectedCurrentLoadoutId !== undefined
          ? { expectedCurrentLoadoutId }
          : expectUnbound === true
            ? { expectedCurrentLoadoutId: null }
            : {}),
      });
    });
  }

  if (command === 'loadout list') {
    return withProjectStore(parsed, dependencies, async ({ store }) => {
      const listRoleLoadouts = requireStoreMethod(store, 'listRoleLoadouts', 'loadout list');
      return listRoleLoadouts({
        role: optionalStringFlag(parsed, 'role'),
        limit: optionalIntegerFlag(parsed, 'limit', 100, {
          min: 1,
          max: PROJECT_BRAIN_LIST_LIMIT_MAX,
        }),
      });
    });
  }

  if (command === 'loadout show') {
    return withProjectStore(parsed, dependencies, async ({ store }) => {
      const resolveRoleLoadout = requireStoreMethod(store, 'resolveRoleLoadout', 'loadout show');
      const role = requiredStringFlag(parsed, 'role');
      const resolved = resolveRoleLoadout(role);
      if (!resolved) throw new AgentTeamError('loadout_not_found', `No active role loadout for role: ${role}`, undefined, 2);
      return resolved;
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
