import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  canonicalHash,
  canonicalParse,
  canonicalStringify,
} from './canonical-json.mjs';

const TASK_STATES = {
  queued: 'queued',
  running: 'running',
  waitingChildren: 'waiting_children',
  completed: 'completed',
  failed: 'failed',
};

const TERMINAL_TASK_STATES = new Set([
  TASK_STATES.completed,
  TASK_STATES.failed,
]);

const OUTBOX_STATES = {
  pending: 'pending',
  leased: 'leased',
  acked: 'acked',
};

const PROJECT_ASSET_KINDS = new Set(['memory', 'skill', 'knowledge']);
const PROJECT_MEMORY_LAYERS = new Set(['l1', 'l2', 'l3']);
const ROLE_LOADOUT_INJECTION_MODES = new Set(['direct', 'summary', 'reference', 'tool']);
const PROJECT_ASSET_MAX_CONTENT_BYTES = 65_536;
const ROLE_LOADOUT_DEFAULT_BYTE_BUDGET = 8_192;
const ROLE_LOADOUT_MAX_BYTE_BUDGET = 65_536;

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        task_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        claim_token TEXT,
        claim_expires_at INTEGER,
        available_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        failed_at INTEGER,
        result_json TEXT,
        error_json TEXT
      );

      CREATE TABLE IF NOT EXISTS task_dependencies (
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        PRIMARY KEY (task_id, depends_on_task_id),
        FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (depends_on_task_id) REFERENCES tasks(task_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_claimable
        ON tasks(state, available_at, created_at);

      CREATE INDEX IF NOT EXISTS idx_tasks_expiry
        ON tasks(state, claim_expires_at);

      CREATE TABLE IF NOT EXISTS outbox_channels (
        channel TEXT PRIMARY KEY,
        capacity INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox (
        message_id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        lease_consumer TEXT,
        lease_token TEXT,
        visible_at INTEGER NOT NULL,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (channel) REFERENCES outbox_channels(channel) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_claim
        ON outbox(channel, state, visible_at, lease_expires_at, created_at);

      CREATE TABLE IF NOT EXISTS event_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        prev_hash TEXT,
        entry_hash TEXT NOT NULL,
        signature TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS project_assets (
        asset_id TEXT PRIMARY KEY,
        asset_key TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        kind TEXT NOT NULL CHECK(kind IN ('memory', 'skill', 'knowledge')),
        memory_layer TEXT CHECK(memory_layer IS NULL OR memory_layer IN ('l1', 'l2', 'l3')),
        title TEXT NOT NULL,
        content_text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        source_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(asset_key, revision)
      );

      CREATE INDEX IF NOT EXISTS idx_project_assets_key_revision
        ON project_assets(asset_key, revision DESC);

      CREATE INDEX IF NOT EXISTS idx_project_assets_kind_layer_created
        ON project_assets(kind, memory_layer, created_at, asset_id);

      CREATE TABLE IF NOT EXISTS role_loadouts (
        loadout_id TEXT PRIMARY KEY,
        loadout_key TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        role TEXT NOT NULL,
        entries_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        byte_budget INTEGER NOT NULL CHECK(byte_budget > 0 AND byte_budget <= 65536),
        created_at INTEGER NOT NULL,
        UNIQUE(loadout_key, revision)
      );

      CREATE INDEX IF NOT EXISTS idx_role_loadouts_key_revision
        ON role_loadouts(loadout_key, revision DESC);

      CREATE INDEX IF NOT EXISTS idx_role_loadouts_role_created
        ON role_loadouts(role, created_at, loadout_id);

      CREATE TABLE IF NOT EXISTS role_loadout_bindings (
        role TEXT PRIMARY KEY,
        loadout_id TEXT NOT NULL,
        bound_at INTEGER NOT NULL,
        FOREIGN KEY (loadout_id) REFERENCES role_loadouts(loadout_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_role_loadout_bindings_loadout
        ON role_loadout_bindings(loadout_id);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE tasks
        ADD COLUMN parent_task_id TEXT REFERENCES tasks(task_id) ON DELETE RESTRICT;

      ALTER TABLE tasks
        ADD COLUMN slice_key TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_parent_slice_unique
        ON tasks(parent_task_id, slice_key)
        WHERE parent_task_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_tasks_parent_created
        ON tasks(parent_task_id, created_at, task_id)
        WHERE parent_task_id IS NOT NULL;
    `,
  },
];

export class TaskConflictError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'TaskConflictError';
    this.details = details;
  }
}

export class OutboxBackpressureError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'OutboxBackpressureError';
    this.details = details;
  }
}

function defaultNow() {
  return Date.now();
}

function defaultGenerateId() {
  return randomUUID();
}

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

function parseJsonColumn(value) {
  return value === null ? null : canonicalParse(value);
}

function requireString(name, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function requirePositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function requireNonNegativeInteger(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function requireAnyString(name, value) {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string`);
  }
}

function requireEnum(name, value, allowedValues) {
  if (typeof value !== 'string' || !allowedValues.has(value)) {
    throw new TypeError(`${name} must be one of: ${[...allowedValues].join(', ')}`);
  }
}

function requireNullableEnum(name, value, allowedValues) {
  if (value === null || value === undefined) {
    return null;
  }
  requireEnum(name, value, allowedValues);
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertMaxUtf8Bytes(name, value, maxBytes) {
  requireAnyString(name, value);
  const size = Buffer.byteLength(value, 'utf8');
  if (size > maxBytes) {
    throw new TypeError(`${name} must be <= ${maxBytes} UTF-8 bytes`);
  }
}

function escapeSqlLikePattern(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry);
    }
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}

function normalizeRoleLoadoutEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError('entries must contain plain objects');
  }

  requireString('entry.assetId', entry.assetId);
  requireEnum('entry.injectionMode', entry.injectionMode, ROLE_LOADOUT_INJECTION_MODES);
  if (!Number.isInteger(entry.priority)) {
    throw new TypeError('entry.priority must be an integer');
  }

  return {
    assetId: entry.assetId,
    injectionMode: entry.injectionMode,
    priority: entry.priority,
  };
}

function normalizeRoleLoadoutEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError('entries must be an array');
  }

  const seenAssetIds = new Set();
  const normalized = entries.map(normalizeRoleLoadoutEntry);
  for (const entry of normalized) {
    if (seenAssetIds.has(entry.assetId)) {
      throw new TypeError(`Duplicate assetId in entries: ${entry.assetId}`);
    }
    seenAssetIds.add(entry.assetId);
  }

  normalized.sort((left, right) => {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }
    return left.assetId.localeCompare(right.assetId);
  });

  return normalized;
}

function normalizeProjectAssetInput({
  assetKey,
  kind,
  memoryLayer = null,
  title,
  contentText,
  source = null,
  expectedRevision,
  assetId,
}) {
  requireString('assetKey', assetKey);
  requireString('assetId', assetId);
  requireNonNegativeInteger('expectedRevision', expectedRevision);
  requireEnum('kind', kind, PROJECT_ASSET_KINDS);

  const normalizedMemoryLayer = requireNullableEnum(
    'memoryLayer',
    memoryLayer,
    PROJECT_MEMORY_LAYERS,
  );
  if (kind !== 'memory' && normalizedMemoryLayer !== null) {
    throw new TypeError('memoryLayer is only allowed for memory assets');
  }

  requireString('title', title);
  assertMaxUtf8Bytes('contentText', contentText, PROJECT_ASSET_MAX_CONTENT_BYTES);

  const sourceJson = canonicalStringify(source);
  const normalizedSource = canonicalParse(sourceJson);
  const contentHash = canonicalHash({
    kind,
    memoryLayer: normalizedMemoryLayer,
    title,
    contentText,
    source: normalizedSource,
  });

  return {
    assetId,
    assetKey,
    expectedRevision,
    kind,
    memoryLayer: normalizedMemoryLayer,
    title,
    contentText,
    sourceJson,
    normalizedSource,
    contentHash,
  };
}

function normalizeRoleLoadoutInput({
  loadoutKey,
  role,
  entries,
  byteBudget = ROLE_LOADOUT_DEFAULT_BYTE_BUDGET,
  expectedRevision,
  loadoutId,
}) {
  requireString('loadoutKey', loadoutKey);
  requireString('role', role);
  requireString('loadoutId', loadoutId);
  requireNonNegativeInteger('expectedRevision', expectedRevision);
  requirePositiveInteger('byteBudget', byteBudget);
  if (byteBudget > ROLE_LOADOUT_MAX_BYTE_BUDGET) {
    throw new TypeError(`byteBudget must be <= ${ROLE_LOADOUT_MAX_BYTE_BUDGET}`);
  }

  const normalizedEntries = normalizeRoleLoadoutEntries(entries);
  const entriesJson = canonicalStringify(normalizedEntries);
  const contentHash = canonicalHash({
    role,
    entries: normalizedEntries,
    byteBudget,
  });

  return {
    loadoutId,
    loadoutKey,
    role,
    expectedRevision,
    byteBudget,
    entries: normalizedEntries,
    entriesJson,
    contentHash,
  };
}

function rowToTask(row) {
  if (!row) {
    return null;
  }

  return {
    taskId: row.task_id,
    key: row.task_key,
    parentTaskId: row.parent_task_id ?? null,
    sliceKey: row.slice_key ?? null,
    payload: parseJsonColumn(row.payload_json),
    payloadHash: row.payload_hash,
    state: row.state,
    generation: row.generation,
    worker: row.lease_owner,
    claimToken: row.claim_token,
    claimExpiresAt: row.claim_expires_at,
    availableAt: row.available_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    result: parseJsonColumn(row.result_json),
    error: parseJsonColumn(row.error_json),
  };
}

function rowToOutboxMessage(row) {
  if (!row) {
    return null;
  }

  return {
    messageId: row.message_id,
    channel: row.channel,
    payload: parseJsonColumn(row.payload_json),
    state: row.state,
    generation: row.generation,
    consumer: row.lease_consumer,
    leaseToken: row.lease_token,
    visibleAt: row.visible_at,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToChannel(row) {
  if (!row) {
    return null;
  }

  return {
    channel: row.channel,
    capacity: row.capacity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pendingDepth: row.pending_depth ?? 0,
  };
}

function rowToProjectAsset(row) {
  if (!row) {
    return null;
  }

  return {
    assetId: row.asset_id,
    assetKey: row.asset_key,
    revision: row.revision,
    kind: row.kind,
    memoryLayer: row.memory_layer,
    title: row.title,
    contentText: row.content_text,
    contentHash: row.content_hash,
    source: parseJsonColumn(row.source_json),
    createdAt: row.created_at,
  };
}

function rowToRoleLoadout(row) {
  if (!row) {
    return null;
  }

  return {
    loadoutId: row.loadout_id,
    loadoutKey: row.loadout_key,
    revision: row.revision,
    role: row.role,
    entries: parseJsonColumn(row.entries_json),
    contentHash: row.content_hash,
    byteBudget: row.byte_budget,
    createdAt: row.created_at,
  };
}

function rowToRoleLoadoutBinding(row) {
  if (!row) {
    return null;
  }

  return {
    role: row.role,
    loadoutId: row.loadout_id,
    boundAt: row.bound_at,
  };
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    };
  }
  return error;
}

export function openProjectStore(options) {
  const {
    dbPath = ':memory:',
    secretKeyPath,
    now = defaultNow,
    generateId = defaultGenerateId,
    defaultTaskTtlMs = 30_000,
    defaultOutboxLeaseMs = 30_000,
  } = options ?? {};

  if (!secretKeyPath) {
    throw new TypeError('secretKeyPath is required');
  }

  const secretKey = readFileSync(secretKeyPath);
  if (secretKey.byteLength === 0) {
    throw new TypeError('secretKeyPath must contain a non-empty key');
  }

  const db = new DatabaseSync(dbPath);
  const statements = new Map();

  function prepare(sql) {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  }

  function sign(value) {
    return createHmac('sha256', secretKey).update(value).digest('hex');
  }

  function withTransaction(mode, fn) {
    db.exec(`BEGIN ${mode}`);
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the original error if rollback itself fails.
      }
      throw error;
    }
  }

  function initialize() {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);

    withTransaction('IMMEDIATE', () => {
      for (const migration of MIGRATIONS) {
        const applied = prepare(
          'SELECT version FROM schema_migrations WHERE version = ?',
        ).get(migration.version);
        if (applied) {
          continue;
        }
        db.exec(migration.sql);
        prepare(
          'INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)',
        ).run(migration.version, now());
      }

      const headJsonRow = prepare('SELECT value FROM meta WHERE key = ?').get(
        'event_head_json',
      );
      if (!headJsonRow) {
        const initialHead = canonicalStringify({
          seq: 0,
          entryHash: null,
          signature: null,
        });
        prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run(
          'event_head_json',
          initialHead,
        );
        prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run(
          'event_head_signature',
          sign(initialHead),
        );
      }
    });
  }

  function getHeadMetadata() {
    const headJsonRow = prepare('SELECT value FROM meta WHERE key = ?').get(
      'event_head_json',
    );
    const headSignatureRow = prepare('SELECT value FROM meta WHERE key = ?').get(
      'event_head_signature',
    );
    if (!headJsonRow || !headSignatureRow) {
      throw new Error('Event head metadata is missing');
    }
    return {
      head: canonicalParse(headJsonRow.value),
      headJson: headJsonRow.value,
      headSignature: headSignatureRow.value,
    };
  }

  function setHeadMetadata(head) {
    const headJson = canonicalStringify(head);
    prepare('UPDATE meta SET value = ? WHERE key = ?').run(
      headJson,
      'event_head_json',
    );
    prepare('UPDATE meta SET value = ? WHERE key = ?').run(
      sign(headJson),
      'event_head_signature',
    );
  }

  function appendEvent(kind, entityType, entityId, payload) {
    const occurredAt = now();
    const payloadJson = canonicalStringify(payload);
    const { head } = getHeadMetadata();
    const body = {
      seq: head.seq + 1,
      occurredAt,
      kind,
      entityType,
      entityId,
      payload: canonicalParse(payloadJson),
      prevHash: head.entryHash,
    };
    const bodyJson = canonicalStringify(body);
    const signature = sign(bodyJson);
    const entryHash = sha256Hex(
      canonicalStringify({
        ...body,
        signature,
      }),
    );

    prepare(
      `INSERT INTO event_log(
        occurred_at,
        kind,
        entity_type,
        entity_id,
        payload_json,
        prev_hash,
        entry_hash,
        signature
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      occurredAt,
      kind,
      entityType,
      entityId,
      payloadJson,
      head.entryHash,
      entryHash,
      signature,
    );

    setHeadMetadata({
      seq: body.seq,
      entryHash,
      signature,
    });
  }

  function getTaskRowById(taskId) {
    return prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
  }

  function getTaskRowByKey(taskKey) {
    return prepare('SELECT * FROM tasks WHERE task_key = ?').get(taskKey);
  }

  function getTaskDependencyIds(taskId) {
    return prepare(
      'SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id',
    ).all(taskId).map((row) => row.depends_on_task_id);
  }

  function hydrateTask(row) {
    const task = rowToTask(row);
    if (task) task.dependencies = getTaskDependencyIds(task.taskId);
    return task;
  }

  function listTaskChildRows(parentTaskId) {
    return prepare(
      `SELECT *
       FROM tasks
       WHERE parent_task_id = ?
       ORDER BY created_at, task_id`,
    ).all(parentTaskId);
  }

  function normalizeFanOutChildren(children, parentTaskId) {
    if (!Array.isArray(children)) {
      throw new TypeError('children must be an array');
    }
    if (children.length < 1 || children.length > 16) {
      throw new TypeError('children must contain between 1 and 16 tasks');
    }

    const seenSliceKeys = new Set();
    const seenKeys = new Set();
    const seenTaskIds = new Set();
    const normalized = children.map((child, index) => {
      if (!isPlainObject(child)) {
        throw new TypeError(`children[${index}] must be a plain object`);
      }

      requireString(`children[${index}].sliceKey`, child.sliceKey);
      requireString(`children[${index}].key`, child.key);
      if (seenSliceKeys.has(child.sliceKey)) {
        throw new TypeError(`Duplicate child sliceKey: ${child.sliceKey}`);
      }
      if (seenKeys.has(child.key)) {
        throw new TypeError(`Duplicate child key: ${child.key}`);
      }
      seenSliceKeys.add(child.sliceKey);
      seenKeys.add(child.key);

      const taskId = child.taskId ?? generateId();
      requireString(`children[${index}].taskId`, taskId);
      if (taskId === parentTaskId) {
        throw new TypeError(`Child task "${taskId}" cannot be its own parent`);
      }
      if (seenTaskIds.has(taskId)) {
        throw new TypeError(`Duplicate child taskId: ${taskId}`);
      }
      seenTaskIds.add(taskId);

      const dependencySliceKeys = child.dependencySliceKeys ?? [];
      if (!Array.isArray(dependencySliceKeys)) {
        throw new TypeError(
          `children[${index}].dependencySliceKeys must be an array`,
        );
      }
      for (const dependencySliceKey of dependencySliceKeys) {
        requireString(
          `children[${index}].dependencySliceKey`,
          dependencySliceKey,
        );
      }

      return {
        taskId,
        key: child.key,
        sliceKey: child.sliceKey,
        payload: child.payload,
        payloadJson: canonicalStringify(child.payload),
        payloadHash: canonicalHash(child.payload),
        dependencySliceKeys: [...new Set(dependencySliceKeys)].sort(),
      };
    });

    const childBySliceKey = new Map(
      normalized.map((child) => [child.sliceKey, child]),
    );
    for (const child of normalized) {
      for (const dependencySliceKey of child.dependencySliceKeys) {
        if (dependencySliceKey === child.sliceKey) {
          throw new TypeError(
            `Child slice "${child.sliceKey}" cannot depend on itself`,
          );
        }
        if (!childBySliceKey.has(dependencySliceKey)) {
          throw new TypeError(
            `Child slice "${child.sliceKey}" references unknown sibling "${dependencySliceKey}"`,
          );
        }
      }
    }

    const visitState = new Map();
    function visit(sliceKey) {
      const state = visitState.get(sliceKey);
      if (state === 'visiting') {
        throw new TypeError('Child dependency graph contains a cycle');
      }
      if (state === 'visited') {
        return;
      }

      visitState.set(sliceKey, 'visiting');
      for (const dependencySliceKey of childBySliceKey.get(sliceKey).dependencySliceKeys) {
        visit(dependencySliceKey);
      }
      visitState.set(sliceKey, 'visited');
    }
    for (const child of normalized) {
      visit(child.sliceKey);
    }

    return {
      normalized,
      childBySliceKey,
    };
  }

  function mergeFanOutResult(result, childTaskIds) {
    const normalizedResult = canonicalParse(canonicalStringify(result));
    const baseResult = isPlainObject(normalizedResult)
      ? normalizedResult
      : { plannerResult: normalizedResult };
    const existingTeam = isPlainObject(baseResult.team)
      ? baseResult.team
      : baseResult.team === undefined
        ? {}
        : { plannerResult: baseResult.team };

    return {
      ...baseResult,
      team: {
        ...existingTeam,
        phase: 'waiting-children',
        childTaskIds,
      },
    };
  }

  function failQueuedDependencyDescendants(rootTaskId, failedAt) {
    const terminalTaskIds = [rootTaskId];
    const queue = [rootTaskId];
    const seen = new Set(queue);

    while (queue.length > 0) {
      const dependencyTaskId = queue.shift();
      const dependentRows = prepare(
        `SELECT t.*
         FROM task_dependencies d
         JOIN tasks t ON t.task_id = d.task_id
         WHERE d.depends_on_task_id = ?
           AND t.state = ?
         ORDER BY t.created_at, t.task_id`,
      ).all(dependencyTaskId, TASK_STATES.queued);

      for (const dependentRow of dependentRows) {
        const dependencyError = {
          code: 'dependency_failed',
          dependencyTaskId,
          message: `Dependency task "${dependencyTaskId}" failed`,
        };
        const update = prepare(
          `UPDATE tasks
           SET state = ?,
               lease_owner = NULL,
               claim_token = NULL,
               claim_expires_at = NULL,
               error_json = ?,
               result_json = NULL,
               updated_at = ?,
               failed_at = ?,
               completed_at = NULL
           WHERE task_id = ?
             AND state = ?`,
        ).run(
          TASK_STATES.failed,
          canonicalStringify(dependencyError),
          failedAt,
          failedAt,
          dependentRow.task_id,
          TASK_STATES.queued,
        );
        if (update.changes !== 1) {
          continue;
        }

        terminalTaskIds.push(dependentRow.task_id);
        appendEvent('task.failed', 'task', dependentRow.task_id, {
          taskId: dependentRow.task_id,
          generation: dependentRow.generation,
          reason: dependencyError.code,
          dependencyTaskId,
        });

        if (!seen.has(dependentRow.task_id)) {
          seen.add(dependentRow.task_id);
          queue.push(dependentRow.task_id);
        }
      }
    }

    return terminalTaskIds;
  }

  function wakeSettledParents(terminalTaskIds, settledAt) {
    const parentTaskIds = new Set();
    for (const terminalTaskId of terminalTaskIds) {
      const row = getTaskRowById(terminalTaskId);
      if (row?.parent_task_id) {
        parentTaskIds.add(row.parent_task_id);
      }
    }

    for (const parentTaskId of parentTaskIds) {
      const parentRow = getTaskRowById(parentTaskId);
      if (!parentRow || parentRow.state !== TASK_STATES.waitingChildren) {
        continue;
      }

      const childRows = listTaskChildRows(parentTaskId);
      if (
        childRows.length === 0 ||
        childRows.some((childRow) => !TERMINAL_TASK_STATES.has(childRow.state))
      ) {
        continue;
      }

      const update = prepare(
        `UPDATE tasks
         SET state = ?,
             lease_owner = NULL,
             claim_token = NULL,
             claim_expires_at = NULL,
             available_at = ?,
             updated_at = ?,
             completed_at = NULL,
             failed_at = NULL
         WHERE task_id = ?
           AND state = ?`,
      ).run(
        TASK_STATES.queued,
        settledAt,
        settledAt,
        parentTaskId,
        TASK_STATES.waitingChildren,
      );
      if (update.changes !== 1) {
        throw new TaskConflictError('settled parent wake-up fence changed during transaction', {
          parentTaskId,
          state: parentRow.state,
          childTaskIds: childRows.map((childRow) => childRow.task_id),
        });
      }

      appendEvent('task.children-settled', 'task', parentTaskId, {
        taskId: parentTaskId,
        childTaskIds: childRows.map((childRow) => childRow.task_id),
        completedTaskIds: childRows
          .filter((childRow) => childRow.state === TASK_STATES.completed)
          .map((childRow) => childRow.task_id),
        failedTaskIds: childRows
          .filter((childRow) => childRow.state === TASK_STATES.failed)
          .map((childRow) => childRow.task_id),
      });
    }
  }

  function getOutboxRowById(messageId) {
    return prepare('SELECT * FROM outbox WHERE message_id = ?').get(messageId);
  }

  function getProjectAssetRowById(assetId) {
    return prepare('SELECT * FROM project_assets WHERE asset_id = ?').get(assetId);
  }

  function getProjectAssetRowByKeyRevision(assetKey, revision) {
    return prepare(
      'SELECT * FROM project_assets WHERE asset_key = ? AND revision = ?',
    ).get(assetKey, revision);
  }

  function getLatestProjectAssetRow(assetKey) {
    return prepare(
      'SELECT * FROM project_assets WHERE asset_key = ? ORDER BY revision DESC LIMIT 1',
    ).get(assetKey);
  }

  function getRoleLoadoutRowById(loadoutId) {
    return prepare('SELECT * FROM role_loadouts WHERE loadout_id = ?').get(loadoutId);
  }

  function getRoleLoadoutRowByKeyRevision(loadoutKey, revision) {
    return prepare(
      'SELECT * FROM role_loadouts WHERE loadout_key = ? AND revision = ?',
    ).get(loadoutKey, revision);
  }

  function getLatestRoleLoadoutRow(loadoutKey) {
    return prepare(
      'SELECT * FROM role_loadouts WHERE loadout_key = ? ORDER BY revision DESC LIMIT 1',
    ).get(loadoutKey);
  }

  function getRoleLoadoutBindingRow(role) {
    return prepare('SELECT * FROM role_loadout_bindings WHERE role = ?').get(role);
  }

  function isProjectAssetReplay(row, candidate) {
    return (
      row.kind === candidate.kind &&
      row.memory_layer === candidate.memoryLayer &&
      row.title === candidate.title &&
      row.content_text === candidate.contentText &&
      row.content_hash === candidate.contentHash &&
      row.source_json === candidate.sourceJson
    );
  }

  function isRoleLoadoutReplay(row, candidate) {
    return (
      row.role === candidate.role &&
      row.entries_json === candidate.entriesJson &&
      row.content_hash === candidate.contentHash &&
      row.byte_budget === candidate.byteBudget
    );
  }

  function getChannelRow(channel) {
    return prepare(
      `SELECT c.channel, c.capacity, c.created_at, c.updated_at,
              COUNT(o.message_id) AS pending_depth
       FROM outbox_channels c
       LEFT JOIN outbox o
         ON o.channel = c.channel
        AND o.state != ?
       WHERE c.channel = ?
       GROUP BY c.channel, c.capacity, c.created_at, c.updated_at`,
    ).get(OUTBOX_STATES.acked, channel);
  }

  function getChannelOutstandingDepth(channel) {
    return prepare(
      'SELECT COUNT(*) AS depth FROM outbox WHERE channel = ? AND state != ?',
    ).get(channel, OUTBOX_STATES.acked).depth;
  }

  function isTaskChannelSaturated(taskRow) {
    const payload = parseJsonColumn(taskRow.payload_json);
    const channel = payload?.channel;
    if (typeof channel !== 'string' || channel.length === 0) {
      return false;
    }

    const configuredChannel = getChannelRow(channel);
    if (!configuredChannel) {
      return false;
    }

    return getChannelOutstandingDepth(channel) >= configuredChannel.capacity;
  }

  function findClaimCandidate(taskId) {
    const claimNow = now();

    if (taskId) {
      const candidate = prepare(
        `SELECT t.*
         FROM tasks t
         WHERE t.task_id = ?
           AND t.state = ?
           AND t.available_at <= ?
           AND NOT EXISTS (
             SELECT 1
             FROM task_dependencies d
             JOIN tasks dep ON dep.task_id = d.depends_on_task_id
             WHERE d.task_id = t.task_id
               AND dep.state != ?
           )
         LIMIT 1`,
      ).get(taskId, TASK_STATES.queued, claimNow, TASK_STATES.completed);
      if (!candidate || isTaskChannelSaturated(candidate)) {
        return null;
      }
      return candidate;
    }

    const candidates = prepare(
      `SELECT t.*
       FROM tasks t
       WHERE t.state = ?
         AND t.available_at <= ?
         AND NOT EXISTS (
           SELECT 1
           FROM task_dependencies d
           JOIN tasks dep ON dep.task_id = d.depends_on_task_id
           WHERE d.task_id = t.task_id
             AND dep.state != ?
         )
       ORDER BY t.created_at, t.task_id`,
    ).all(TASK_STATES.queued, claimNow, TASK_STATES.completed);

    for (const candidate of candidates) {
      if (!isTaskChannelSaturated(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  function ensureChannelConfigured(channel, capacity) {
    const existing = getChannelRow(channel);
    if (existing) {
      if (capacity !== undefined && capacity !== existing.capacity) {
        throw new OutboxBackpressureError(
          `Channel "${channel}" already exists with capacity ${existing.capacity}`,
          {
            channel,
            capacity: existing.capacity,
            requestedCapacity: capacity,
          },
        );
      }
      return rowToChannel(existing);
    }

    if (capacity === undefined) {
      throw new TypeError(
        `Channel "${channel}" is not configured; provide capacity once to persist it`,
      );
    }

    requirePositiveInteger('capacity', capacity);
    const createdAt = now();
    prepare(
      'INSERT INTO outbox_channels(channel, capacity, created_at, updated_at) VALUES(?, ?, ?, ?)',
    ).run(channel, capacity, createdAt, createdAt);
    appendEvent('outbox.channel-configured', 'channel', channel, {
      channel,
      capacity,
    });
    return rowToChannel(getChannelRow(channel));
  }

  function enqueueOutboxWithinTransaction({
    channel,
    payload,
    capacity,
    visibleAt,
    messageId,
    taskId,
    worker,
    generation,
    claimToken,
  }) {
    const hasFence = [taskId, worker, generation, claimToken].some((value) => value !== undefined);
    if (hasFence) {
      const enqueueAt = now();
      const current = prepare(
        `SELECT task_id
         FROM tasks
         WHERE task_id = ?
           AND lease_owner = ?
           AND generation = ?
           AND claim_token = ?
           AND state = ?
           AND claim_expires_at >= ?`,
      ).get(taskId, worker, generation, claimToken, TASK_STATES.running, enqueueAt);
      if (!current) {
        throw new TaskConflictError('task-scoped outbox write was fenced out', {
          taskId,
          worker,
          generation,
        });
      }
    }

    const payloadJson = canonicalStringify(payload);
    const existing = getOutboxRowById(messageId);
    if (existing) {
      if (existing.channel === channel && existing.payload_json === payloadJson) {
        return rowToOutboxMessage(existing);
      }
      throw new TaskConflictError(
        `Outbox message "${messageId}" already exists with different content`,
        {
          messageId,
          existingChannel: existing.channel,
          requestedChannel: channel,
          existingPayloadHash: canonicalHash(parseJsonColumn(existing.payload_json)),
          requestedPayloadHash: canonicalHash(payload),
        },
      );
    }

    const channelConfig = ensureChannelConfigured(channel, capacity);
    const depth = getChannelOutstandingDepth(channel);
    if (depth >= channelConfig.capacity) {
      throw new OutboxBackpressureError(
        `Outbox channel "${channel}" is full`,
        {
          channel,
          capacity: channelConfig.capacity,
          depth,
        },
      );
    }

    const createdAt = now();
    prepare(
      `INSERT INTO outbox(
        message_id,
        channel,
        payload_json,
        state,
        generation,
        lease_consumer,
        lease_token,
        visible_at,
        lease_expires_at,
        created_at,
        updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      messageId,
      channel,
      payloadJson,
      OUTBOX_STATES.pending,
      0,
      null,
      null,
      visibleAt,
      null,
      createdAt,
      createdAt,
    );

    appendEvent('outbox.enqueued', 'outbox', messageId, {
      channel,
      messageId,
      taskId: taskId ?? null,
      visibleAt,
      payloadHash: canonicalHash(payload),
    });

    return rowToOutboxMessage(getOutboxRowById(messageId));
  }

  initialize();

  return {
    close() {
      db.close();
    },

    configureChannel({ channel, capacity }) {
      requireString('channel', channel);
      requirePositiveInteger('capacity', capacity);

      return withTransaction('IMMEDIATE', () => {
        const existing = getChannelRow(channel);
        if (!existing) {
          const createdAt = now();
          prepare(
            'INSERT INTO outbox_channels(channel, capacity, created_at, updated_at) VALUES(?, ?, ?, ?)',
          ).run(channel, capacity, createdAt, createdAt);
          appendEvent('outbox.channel-configured', 'channel', channel, {
            channel,
            capacity,
          });
        } else if (existing.capacity !== capacity) {
          prepare(
            'UPDATE outbox_channels SET capacity = ?, updated_at = ? WHERE channel = ?',
          ).run(capacity, now(), channel);
          appendEvent('outbox.channel-updated', 'channel', channel, {
            channel,
            capacity,
          });
        }

        return rowToChannel(getChannelRow(channel));
      });
    },

    getChannel(channel) {
      requireString('channel', channel);
      return rowToChannel(getChannelRow(channel));
    },

    listChannels() {
      return prepare(
        `SELECT c.channel, c.capacity, c.created_at, c.updated_at,
                COUNT(o.message_id) AS pending_depth
         FROM outbox_channels c
         LEFT JOIN outbox o
           ON o.channel = c.channel
          AND o.state != ?
         GROUP BY c.channel, c.capacity, c.created_at, c.updated_at
         ORDER BY c.channel`,
      )
        .all(OUTBOX_STATES.acked)
        .map(rowToChannel);
    },

    createProjectAsset({
      assetKey,
      kind,
      memoryLayer = null,
      title,
      contentText,
      source = null,
      expectedRevision = 0,
      assetId = generateId(),
    }) {
      const candidate = normalizeProjectAssetInput({
        assetKey,
        kind,
        memoryLayer,
        title,
        contentText,
        source,
        expectedRevision,
        assetId,
      });

      return withTransaction('IMMEDIATE', () => {
        const replayRevision = candidate.expectedRevision + 1;
        const replay = getProjectAssetRowByKeyRevision(candidate.assetKey, replayRevision);
        if (replay) {
          if (isProjectAssetReplay(replay, candidate)) {
            return {
              status: 'replayed',
              asset: rowToProjectAsset(replay),
            };
          }
          throw new TaskConflictError(
            `Project asset "${candidate.assetKey}" revision ${replayRevision} already exists with different content`,
            {
              assetKey: candidate.assetKey,
              revision: replayRevision,
              existingAssetId: replay.asset_id,
              existingContentHash: replay.content_hash,
              requestedContentHash: candidate.contentHash,
            },
          );
        }

        const latest = getLatestProjectAssetRow(candidate.assetKey);
        const latestRevision = latest?.revision ?? 0;
        if (latestRevision !== candidate.expectedRevision) {
          throw new TaskConflictError(
            `Project asset "${candidate.assetKey}" expected revision ${candidate.expectedRevision} but latest is ${latestRevision}`,
            {
              assetKey: candidate.assetKey,
              expectedRevision: candidate.expectedRevision,
              latestRevision,
              latestAssetId: latest?.asset_id ?? null,
            },
          );
        }

        const revision = latestRevision + 1;
        const createdAt = now();
        prepare(
          `INSERT INTO project_assets(
            asset_id,
            asset_key,
            revision,
            kind,
            memory_layer,
            title,
            content_text,
            content_hash,
            source_json,
            created_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          candidate.assetId,
          candidate.assetKey,
          revision,
          candidate.kind,
          candidate.memoryLayer,
          candidate.title,
          candidate.contentText,
          candidate.contentHash,
          candidate.sourceJson,
          createdAt,
        );

        appendEvent('project-asset.created', 'project_asset', candidate.assetId, {
          assetId: candidate.assetId,
          assetKey: candidate.assetKey,
          revision,
          contentHash: candidate.contentHash,
        });

        return {
          status: 'created',
          asset: rowToProjectAsset(getProjectAssetRowById(candidate.assetId)),
        };
      });
    },

    getProjectAsset(query) {
      if (typeof query === 'string') {
        return rowToProjectAsset(getProjectAssetRowById(query));
      }
      if (!query || typeof query !== 'object' || Array.isArray(query)) {
        throw new TypeError('getProjectAsset requires an assetId string or query object');
      }

      if (query.assetId !== undefined) {
        requireString('assetId', query.assetId);
        return rowToProjectAsset(getProjectAssetRowById(query.assetId));
      }

      requireString('assetKey', query.assetKey);
      if (query.revision === undefined) {
        return rowToProjectAsset(getLatestProjectAssetRow(query.assetKey));
      }

      requirePositiveInteger('revision', query.revision);
      return rowToProjectAsset(
        getProjectAssetRowByKeyRevision(query.assetKey, query.revision),
      );
    },

    listProjectAssets(filters = {}) {
      const clauses = [];
      const params = [];

      if (filters.assetKey) {
        requireString('assetKey', filters.assetKey);
        clauses.push('asset_key = ?');
        params.push(filters.assetKey);
      }
      if (filters.keyPrefix) {
        requireString('keyPrefix', filters.keyPrefix);
        clauses.push("asset_key LIKE ? ESCAPE '\\'");
        params.push(`${escapeSqlLikePattern(filters.keyPrefix)}%`);
      }
      if (filters.kind) {
        requireEnum('kind', filters.kind, PROJECT_ASSET_KINDS);
        clauses.push('kind = ?');
        params.push(filters.kind);
      }
      if (filters.memoryLayer !== undefined && filters.memoryLayer !== null) {
        requireEnum('memoryLayer', filters.memoryLayer, PROJECT_MEMORY_LAYERS);
        clauses.push('memory_layer = ?');
        params.push(filters.memoryLayer);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = filters.limit ?? 100;
      requirePositiveInteger('limit', limit);

      return prepare(
        `SELECT *
         FROM project_assets
         ${where}
         ORDER BY asset_key, revision DESC, asset_id
         LIMIT ?`,
      )
        .all(...params, limit)
        .map(rowToProjectAsset);
    },

    createRoleLoadout({
      loadoutKey,
      role,
      entries,
      byteBudget = ROLE_LOADOUT_DEFAULT_BYTE_BUDGET,
      expectedRevision = 0,
      loadoutId = generateId(),
    }) {
      const candidate = normalizeRoleLoadoutInput({
        loadoutKey,
        role,
        entries,
        byteBudget,
        expectedRevision,
        loadoutId,
      });

      return withTransaction('IMMEDIATE', () => {
        for (const entry of candidate.entries) {
          if (!getProjectAssetRowById(entry.assetId)) {
            throw new Error(`Unknown project asset: ${entry.assetId}`);
          }
        }

        const replayRevision = candidate.expectedRevision + 1;
        const replay = getRoleLoadoutRowByKeyRevision(candidate.loadoutKey, replayRevision);
        if (replay) {
          if (isRoleLoadoutReplay(replay, candidate)) {
            return {
              status: 'replayed',
              loadout: rowToRoleLoadout(replay),
            };
          }
          throw new TaskConflictError(
            `Role loadout "${candidate.loadoutKey}" revision ${replayRevision} already exists with different content`,
            {
              loadoutKey: candidate.loadoutKey,
              revision: replayRevision,
              existingLoadoutId: replay.loadout_id,
              existingContentHash: replay.content_hash,
              requestedContentHash: candidate.contentHash,
            },
          );
        }

        const latest = getLatestRoleLoadoutRow(candidate.loadoutKey);
        const latestRevision = latest?.revision ?? 0;
        if (latestRevision !== candidate.expectedRevision) {
          throw new TaskConflictError(
            `Role loadout "${candidate.loadoutKey}" expected revision ${candidate.expectedRevision} but latest is ${latestRevision}`,
            {
              loadoutKey: candidate.loadoutKey,
              expectedRevision: candidate.expectedRevision,
              latestRevision,
              latestLoadoutId: latest?.loadout_id ?? null,
            },
          );
        }

        const revision = latestRevision + 1;
        const createdAt = now();
        prepare(
          `INSERT INTO role_loadouts(
            loadout_id,
            loadout_key,
            revision,
            role,
            entries_json,
            content_hash,
            byte_budget,
            created_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          candidate.loadoutId,
          candidate.loadoutKey,
          revision,
          candidate.role,
          candidate.entriesJson,
          candidate.contentHash,
          candidate.byteBudget,
          createdAt,
        );

        appendEvent('role-loadout.created', 'role_loadout', candidate.loadoutId, {
          loadoutId: candidate.loadoutId,
          loadoutKey: candidate.loadoutKey,
          revision,
          role: candidate.role,
          contentHash: candidate.contentHash,
        });

        return {
          status: 'created',
          loadout: rowToRoleLoadout(getRoleLoadoutRowById(candidate.loadoutId)),
        };
      });
    },

    getRoleLoadout(query) {
      if (typeof query === 'string') {
        return rowToRoleLoadout(getRoleLoadoutRowById(query));
      }
      if (!query || typeof query !== 'object' || Array.isArray(query)) {
        throw new TypeError('getRoleLoadout requires a loadoutId string or query object');
      }

      if (query.loadoutId !== undefined) {
        requireString('loadoutId', query.loadoutId);
        return rowToRoleLoadout(getRoleLoadoutRowById(query.loadoutId));
      }

      requireString('loadoutKey', query.loadoutKey);
      if (query.revision === undefined) {
        return rowToRoleLoadout(getLatestRoleLoadoutRow(query.loadoutKey));
      }

      requirePositiveInteger('revision', query.revision);
      return rowToRoleLoadout(
        getRoleLoadoutRowByKeyRevision(query.loadoutKey, query.revision),
      );
    },

    listRoleLoadouts(filters = {}) {
      const clauses = [];
      const params = [];

      if (filters.loadoutKey) {
        requireString('loadoutKey', filters.loadoutKey);
        clauses.push('loadout_key = ?');
        params.push(filters.loadoutKey);
      }
      if (filters.role) {
        requireString('role', filters.role);
        clauses.push('role = ?');
        params.push(filters.role);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = filters.limit ?? 100;
      requirePositiveInteger('limit', limit);

      return prepare(
        `SELECT *
         FROM role_loadouts
         ${where}
         ORDER BY loadout_key, revision DESC, loadout_id
         LIMIT ?`,
      )
        .all(...params, limit)
        .map(rowToRoleLoadout);
    },

    bindRoleLoadout({ role, loadoutId, expectedCurrentLoadoutId } = {}) {
      requireString('role', role);
      requireString('loadoutId', loadoutId);
      if (expectedCurrentLoadoutId !== undefined && expectedCurrentLoadoutId !== null) {
        requireString('expectedCurrentLoadoutId', expectedCurrentLoadoutId);
      }

      return withTransaction('IMMEDIATE', () => {
        const loadoutRow = getRoleLoadoutRowById(loadoutId);
        if (!loadoutRow) {
          throw new Error(`Unknown role loadout: ${loadoutId}`);
        }
        if (loadoutRow.role !== role) {
          throw new TaskConflictError(
            `Role loadout "${loadoutId}" belongs to role "${loadoutRow.role}", not "${role}"`,
            {
              role,
              loadoutId,
              loadoutRole: loadoutRow.role,
            },
          );
        }

        const current = getRoleLoadoutBindingRow(role);
        const currentLoadoutId = current?.loadout_id ?? null;
        const expectedLoadoutId = expectedCurrentLoadoutId ?? null;
        if (expectedCurrentLoadoutId !== undefined && currentLoadoutId !== expectedLoadoutId) {
          throw new TaskConflictError(
            `Role loadout binding for "${role}" expected ${expectedLoadoutId} but found ${currentLoadoutId}`,
            {
              role,
              expectedCurrentLoadoutId: expectedLoadoutId,
              currentLoadoutId,
            },
          );
        }

        if (currentLoadoutId === loadoutId) {
          return {
            status: 'replayed',
            binding: rowToRoleLoadoutBinding(current),
          };
        }

        const boundAt = now();
        prepare(
          `INSERT INTO role_loadout_bindings(role, loadout_id, bound_at)
           VALUES(?, ?, ?)
           ON CONFLICT(role) DO UPDATE
           SET loadout_id = excluded.loadout_id,
               bound_at = excluded.bound_at`,
        ).run(role, loadoutId, boundAt);

        appendEvent('role-loadout.bound', 'role_loadout_binding', role, {
          role,
          loadoutId,
          loadoutRevision: loadoutRow.revision,
          contentHash: loadoutRow.content_hash,
        });

        return {
          status: 'bound',
          binding: rowToRoleLoadoutBinding(getRoleLoadoutBindingRow(role)),
        };
      });
    },

    getRoleLoadoutBinding(role) {
      requireString('role', role);
      return rowToRoleLoadoutBinding(getRoleLoadoutBindingRow(role));
    },

    listRoleLoadoutBindings() {
      return prepare(
        'SELECT role, loadout_id, bound_at FROM role_loadout_bindings ORDER BY role',
      )
        .all()
        .map(rowToRoleLoadoutBinding);
    },

    resolveRoleLoadout(role) {
      requireString('role', role);

      return withTransaction('DEFERRED', () => {
        const binding = getRoleLoadoutBindingRow(role);
        if (!binding) {
          return null;
        }

        const loadout = rowToRoleLoadout(getRoleLoadoutRowById(binding.loadout_id));
        if (!loadout) {
          throw new Error(`Missing role loadout for binding: ${binding.loadout_id}`);
        }

        const assets = loadout.entries.map((entry) => {
          const asset = rowToProjectAsset(getProjectAssetRowById(entry.assetId));
          if (!asset) {
            throw new Error(`Role loadout "${loadout.loadoutId}" references unknown asset: ${entry.assetId}`);
          }
          return {
            assetId: asset.assetId,
            assetKey: asset.assetKey,
            revision: asset.revision,
            kind: asset.kind,
            memoryLayer: asset.memoryLayer,
            title: asset.title,
            contentText: asset.contentText,
            contentHash: asset.contentHash,
            source: asset.source,
            createdAt: asset.createdAt,
            injectionMode: entry.injectionMode,
            priority: entry.priority,
          };
        });

        return deepFreeze({
          role,
          boundAt: binding.bound_at,
          loadoutId: loadout.loadoutId,
          loadoutKey: loadout.loadoutKey,
          loadoutRevision: loadout.revision,
          contentHash: loadout.contentHash,
          byteBudget: loadout.byteBudget,
          assets,
        });
      });
    },

    getTask(taskId) {
      return hydrateTask(getTaskRowById(taskId));
    },

    getTaskByKey(taskKey) {
      return hydrateTask(getTaskRowByKey(taskKey));
    },

    listTaskChildren(parentTaskId) {
      requireString('parentTaskId', parentTaskId);
      return listTaskChildRows(parentTaskId).map(hydrateTask);
    },

    listTasks(filters = {}) {
      const clauses = [];
      const params = [];

      if (filters.state) {
        clauses.push('state = ?');
        params.push(filters.state);
      }
      if (filters.worker) {
        clauses.push('lease_owner = ?');
        params.push(filters.worker);
      }
      if (filters.keyPrefix) {
        clauses.push('task_key LIKE ?');
        params.push(`${filters.keyPrefix}%`);
      }
      if (filters.taskIds?.length) {
        clauses.push(
          `task_id IN (${filters.taskIds.map(() => '?').join(', ')})`,
        );
        params.push(...filters.taskIds);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = filters.limit ?? 100;
      requirePositiveInteger('limit', limit);

      return prepare(
        `SELECT * FROM tasks ${where} ORDER BY created_at, task_id LIMIT ?`,
      )
        .all(...params, limit)
        .map(hydrateTask);
    },

    createTask(input) {
      if (!isPlainObject(input)) {
        throw new TypeError('createTask input must be a plain object');
      }
      if (Object.hasOwn(input, 'parentTaskId') || Object.hasOwn(input, 'sliceKey')) {
        throw new TypeError(
          'Child tasks must be created atomically through fanOutTask',
        );
      }

      const {
        key,
        payload,
        dependencies = [],
        availableAt = now(),
        taskId = generateId(),
      } = input;
      requireString('key', key);
      requireString('taskId', taskId);

      if (!Array.isArray(dependencies)) {
        throw new TypeError('dependencies must be an array');
      }
      for (const dependencyId of dependencies) requireString('dependencyId', dependencyId);

      const payloadJson = canonicalStringify(payload);
      const payloadHash = canonicalHash(payload);
      const dependencyList = [...new Set(dependencies)].sort();

      return withTransaction('IMMEDIATE', () => {
        const existing = getTaskRowByKey(key);
        if (existing) {
          const existingDependencies = getTaskDependencyIds(existing.task_id);
          if (
            existing.payload_hash === payloadHash &&
            existing.payload_json === payloadJson &&
            canonicalStringify(existingDependencies) === canonicalStringify(dependencyList)
          ) {
            return {
              status: 'replayed',
              task: hydrateTask(existing),
            };
          }
          throw new TaskConflictError(
            `Task key "${key}" already exists with a different payload`,
            {
              key,
              existingPayloadHash: existing.payload_hash,
              requestedPayloadHash: payloadHash,
              existingDependencyIds: existingDependencies,
              requestedDependencyIds: dependencyList,
            },
          );
        }

        for (const dependencyId of dependencyList) {
          if (!getTaskRowById(dependencyId)) {
            throw new Error(`Unknown dependency task: ${dependencyId}`);
          }
        }

        const createdAt = now();
        prepare(
          `INSERT INTO tasks(
            task_id,
            task_key,
            payload_json,
            payload_hash,
            state,
            generation,
            lease_owner,
            claim_token,
            claim_expires_at,
            available_at,
            created_at,
            updated_at,
            completed_at,
            failed_at,
            result_json,
            error_json
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          taskId,
          key,
          payloadJson,
          payloadHash,
          TASK_STATES.queued,
          0,
          null,
          null,
          null,
          availableAt,
          createdAt,
          createdAt,
          null,
          null,
          null,
          null,
        );

        for (const dependencyId of dependencyList) {
          prepare(
            'INSERT INTO task_dependencies(task_id, depends_on_task_id) VALUES(?, ?)',
          ).run(taskId, dependencyId);
        }

        appendEvent('task.created', 'task', taskId, {
          taskId,
          key,
          payloadHash,
          availableAt,
          dependencyIds: dependencyList,
        });

        return {
          status: 'created',
          task: hydrateTask(getTaskRowById(taskId)),
        };
      });
    },

    fanOutTask({
      taskId,
      worker,
      generation,
      claimToken,
      result = null,
      children,
    }) {
      requireString('taskId', taskId);
      requireString('worker', worker);
      requireString('claimToken', claimToken);
      requirePositiveInteger('generation', generation);

      return withTransaction('IMMEDIATE', () => {
        const fanOutAt = now();
        const current = prepare(
          `SELECT *
           FROM tasks
           WHERE task_id = ?
             AND lease_owner = ?
             AND generation = ?
             AND claim_token = ?
             AND state = ?
             AND claim_expires_at >= ?`,
        ).get(
          taskId,
          worker,
          generation,
          claimToken,
          TASK_STATES.running,
          fanOutAt,
        );
        if (!current) {
          return null;
        }

        const existingChildren = listTaskChildRows(taskId);
        if (existingChildren.length > 0) {
          throw new TaskConflictError(
            `Task "${taskId}" already has direct children and cannot fan out again`,
            {
              taskId,
              childTaskIds: existingChildren.map((childRow) => childRow.task_id),
              childSliceKeys: existingChildren.map((childRow) => childRow.slice_key),
            },
          );
        }

        const { normalized, childBySliceKey } = normalizeFanOutChildren(
          children,
          taskId,
        );
        for (const child of normalized) {
          const existingByKey = getTaskRowByKey(child.key);
          if (existingByKey) {
            throw new TaskConflictError(
              `Task key "${child.key}" already exists`,
              {
                key: child.key,
                existingTaskId: existingByKey.task_id,
                requestedTaskId: child.taskId,
              },
            );
          }

          const existingById = getTaskRowById(child.taskId);
          if (existingById) {
            throw new TaskConflictError(
              `Task id "${child.taskId}" already exists`,
              {
                taskId: child.taskId,
                existingKey: existingById.task_key,
                requestedKey: child.key,
              },
            );
          }

          const existingSlice = prepare(
            `SELECT task_id
             FROM tasks
             WHERE parent_task_id = ?
               AND slice_key = ?`,
          ).get(taskId, child.sliceKey);
          if (existingSlice) {
            throw new TaskConflictError(
              `Parent task "${taskId}" already has slice "${child.sliceKey}"`,
              {
                parentTaskId: taskId,
                sliceKey: child.sliceKey,
                existingTaskId: existingSlice.task_id,
              },
            );
          }
        }

        const childTaskIds = normalized.map((child) => child.taskId);
        const mergedResult = mergeFanOutResult(result, childTaskIds);
        const mergedResultJson = canonicalStringify(mergedResult);

        for (const child of normalized) {
          prepare(
            `INSERT INTO tasks(
              task_id,
              task_key,
              payload_json,
              payload_hash,
              state,
              generation,
              lease_owner,
              claim_token,
              claim_expires_at,
              available_at,
              created_at,
              updated_at,
              completed_at,
              failed_at,
              result_json,
              error_json,
              parent_task_id,
              slice_key
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            child.taskId,
            child.key,
            child.payloadJson,
            child.payloadHash,
            TASK_STATES.queued,
            0,
            null,
            null,
            null,
            fanOutAt,
            fanOutAt,
            fanOutAt,
            null,
            null,
            null,
            null,
            taskId,
            child.sliceKey,
          );
        }

        for (const child of normalized) {
          const dependencyTaskIds = child.dependencySliceKeys
            .map((dependencySliceKey) => childBySliceKey.get(dependencySliceKey).taskId)
            .sort();
          for (const dependencyTaskId of dependencyTaskIds) {
            prepare(
              'INSERT INTO task_dependencies(task_id, depends_on_task_id) VALUES(?, ?)',
            ).run(child.taskId, dependencyTaskId);
          }

          appendEvent('task.created', 'task', child.taskId, {
            taskId: child.taskId,
            key: child.key,
            payloadHash: child.payloadHash,
            availableAt: fanOutAt,
            dependencyIds: dependencyTaskIds,
            parentTaskId: taskId,
            sliceKey: child.sliceKey,
          });
        }

        const update = prepare(
          `UPDATE tasks
           SET state = ?,
               lease_owner = NULL,
               claim_token = NULL,
               claim_expires_at = NULL,
               result_json = ?,
               error_json = NULL,
               updated_at = ?,
               completed_at = NULL,
               failed_at = NULL
           WHERE task_id = ?
             AND lease_owner = ?
             AND generation = ?
             AND claim_token = ?
             AND state = ?
             AND claim_expires_at >= ?`,
        ).run(
          TASK_STATES.waitingChildren,
          mergedResultJson,
          fanOutAt,
          taskId,
          worker,
          generation,
          claimToken,
          TASK_STATES.running,
          fanOutAt,
        );
        if (update.changes !== 1) {
          throw new TaskConflictError('fan-out task fence changed during transaction', {
            taskId,
            worker,
            generation,
          });
        }

        appendEvent('task.fanned-out', 'task', taskId, {
          taskId,
          worker,
          generation,
          childTaskIds,
          childSlices: normalized.map((child) => ({
            taskId: child.taskId,
            sliceKey: child.sliceKey,
          })),
          resultHash: canonicalHash(mergedResult),
        });

        return {
          parent: hydrateTask(getTaskRowById(taskId)),
          children: normalized.map((child) => hydrateTask(getTaskRowById(child.taskId))),
        };
      });
    },

    claimTask({ worker, taskId, ttlMs = defaultTaskTtlMs }) {
      requireString('worker', worker);
      requirePositiveInteger('ttlMs', ttlMs);

      return withTransaction('IMMEDIATE', () => {
        const claimNow = now();
        const candidate = findClaimCandidate(taskId);
        if (!candidate) {
          return null;
        }

        const claimToken = generateId();
        const generation = candidate.generation + 1;
        const claimExpiresAt = claimNow + ttlMs;
        const update = prepare(
          `UPDATE tasks
           SET state = ?,
               generation = ?,
               lease_owner = ?,
               claim_token = ?,
               claim_expires_at = ?,
               updated_at = ?
           WHERE task_id = ?
             AND state = ?
             AND generation = ?`,
        ).run(
          TASK_STATES.running,
          generation,
          worker,
          claimToken,
          claimExpiresAt,
          claimNow,
          candidate.task_id,
          TASK_STATES.queued,
          candidate.generation,
        );

        if (update.changes !== 1) {
          return null;
        }

        appendEvent('task.claimed', 'task', candidate.task_id, {
          taskId: candidate.task_id,
          worker,
          generation,
          claimToken,
          claimExpiresAt,
        });

        return hydrateTask(getTaskRowById(candidate.task_id));
      });
    },

    appendTaskEvent({
      taskId,
      worker,
      generation,
      claimToken,
      type,
      payload = null,
    }) {
      requireString('taskId', taskId);
      requireString('worker', worker);
      requireString('claimToken', claimToken);
      requireString('type', type);

      return withTransaction('IMMEDIATE', () => {
        const eventAt = now();
        const row = prepare(
          `SELECT task_id
           FROM tasks
           WHERE task_id = ?
             AND lease_owner = ?
             AND generation = ?
             AND claim_token = ?
             AND state = ?
             AND claim_expires_at >= ?`,
        ).get(
          taskId,
          worker,
          generation,
          claimToken,
          TASK_STATES.running,
          eventAt,
        );

        if (!row) {
          return false;
        }

        appendEvent(`task.event.${type}`, 'task', taskId, {
          taskId,
          worker,
          generation,
          type,
          payload,
        });
        return true;
      });
    },

    heartbeatTask({
      taskId,
      worker,
      generation,
      claimToken,
      ttlMs = defaultTaskTtlMs,
    }) {
      requireString('taskId', taskId);
      requireString('worker', worker);
      requireString('claimToken', claimToken);
      requirePositiveInteger('ttlMs', ttlMs);

      return withTransaction('IMMEDIATE', () => {
        const heartbeatAt = now();
        const claimExpiresAt = heartbeatAt + ttlMs;
        const update = prepare(
          `UPDATE tasks
           SET claim_expires_at = ?,
               updated_at = ?
           WHERE task_id = ?
             AND lease_owner = ?
             AND generation = ?
             AND claim_token = ?
             AND state = ?`,
        ).run(
          claimExpiresAt,
          heartbeatAt,
          taskId,
          worker,
          generation,
          claimToken,
          TASK_STATES.running,
        );

        if (update.changes !== 1) {
          return null;
        }

        appendEvent('task.heartbeat', 'task', taskId, {
          taskId,
          worker,
          generation,
          claimToken,
          claimExpiresAt,
        });

        return hydrateTask(getTaskRowById(taskId));
      });
    },

    completeTask({
      taskId,
      worker,
      generation,
      claimToken,
      result = null,
      outbox = null,
      taskEvent = null,
    }) {
      requireString('taskId', taskId);
      requireString('worker', worker);
      requireString('claimToken', claimToken);
      if (taskEvent !== null) {
        if (!isPlainObject(taskEvent)) {
          throw new TypeError('taskEvent must be a plain object');
        }
        requireString('taskEvent.type', taskEvent.type);
      }

      return withTransaction('IMMEDIATE', () => {
        const completedAt = now();
        const resultJson = canonicalStringify(result);

        const current = prepare(
          `SELECT task_id
           FROM tasks
           WHERE task_id = ?
             AND lease_owner = ?
             AND generation = ?
             AND claim_token = ?
             AND state = ?
             AND claim_expires_at >= ?`,
        ).get(
          taskId,
          worker,
          generation,
          claimToken,
          TASK_STATES.running,
          completedAt,
        );
        if (!current) {
          return null;
        }

        const unsettledChild = prepare(
          `SELECT task_id, state
           FROM tasks
           WHERE parent_task_id = ?
             AND state NOT IN (?, ?)
           ORDER BY created_at, task_id
           LIMIT 1`,
        ).get(taskId, TASK_STATES.completed, TASK_STATES.failed);
        if (unsettledChild) {
          throw new TaskConflictError(
            `Task "${taskId}" cannot complete while child "${unsettledChild.task_id}" is ${unsettledChild.state}`,
            {
              taskId,
              childTaskId: unsettledChild.task_id,
              childState: unsettledChild.state,
            },
          );
        }

        let outboxMessage = null;
        if (outbox) {
          requireString('outbox.channel', outbox.channel);
          requireString('outbox.messageId', outbox.messageId);
          outboxMessage = enqueueOutboxWithinTransaction({
            ...outbox,
            visibleAt: outbox.visibleAt ?? completedAt,
            taskId,
            worker,
            generation,
            claimToken,
          });
        }

        const update = prepare(
          `UPDATE tasks
           SET state = ?,
               lease_owner = NULL,
               claim_token = NULL,
               claim_expires_at = NULL,
               result_json = ?,
               error_json = NULL,
               updated_at = ?,
               completed_at = ?,
               failed_at = NULL
           WHERE task_id = ?
             AND lease_owner = ?
             AND generation = ?
             AND claim_token = ?
             AND state = ?
             AND claim_expires_at >= ?`,
        ).run(
          TASK_STATES.completed,
          resultJson,
          completedAt,
          completedAt,
          taskId,
          worker,
          generation,
          claimToken,
          TASK_STATES.running,
          completedAt,
        );

        if (update.changes !== 1) {
          return null;
        }

        if (taskEvent) {
          appendEvent(`task.event.${taskEvent.type}`, 'task', taskId, {
            taskId,
            worker,
            generation,
            type: taskEvent.type,
            payload: taskEvent.payload ?? null,
          });
        }

        appendEvent('task.completed', 'task', taskId, {
          taskId,
          worker,
          generation,
          resultHash: canonicalHash(result),
        });

        wakeSettledParents([taskId], completedAt);

        const task = hydrateTask(getTaskRowById(taskId));
        return outbox ? { task, outbox: outboxMessage } : task;
      });
    },

    failTask({ taskId, worker, generation, claimToken, error, preserveResult = false }) {
      requireString('taskId', taskId);
      requireString('worker', worker);
      requireString('claimToken', claimToken);

      return withTransaction('IMMEDIATE', () => {
        const failedAt = now();
        const errorJson = canonicalStringify(serializeError(error));
        const update = prepare(
          `UPDATE tasks
           SET state = ?,
               lease_owner = NULL,
               claim_token = NULL,
               claim_expires_at = NULL,
               error_json = ?,
               result_json = CASE WHEN ? THEN result_json ELSE NULL END,
               updated_at = ?,
               failed_at = ?,
               completed_at = NULL
           WHERE task_id = ?
             AND lease_owner = ?
             AND generation = ?
             AND claim_token = ?
             AND state = ?
             AND claim_expires_at >= ?`,
        ).run(
          TASK_STATES.failed,
          errorJson,
          preserveResult ? 1 : 0,
          failedAt,
          failedAt,
          taskId,
          worker,
          generation,
          claimToken,
          TASK_STATES.running,
          failedAt,
        );

        if (update.changes !== 1) {
          return null;
        }

        appendEvent('task.failed', 'task', taskId, {
          taskId,
          worker,
          generation,
        });

        const terminalTaskIds = failQueuedDependencyDescendants(taskId, failedAt);
        wakeSettledParents(terminalTaskIds, failedAt);

        return hydrateTask(getTaskRowById(taskId));
      });
    },

    requeueTaskLease({
      taskId,
      worker,
      generation,
      claimToken,
      availableAt = now(),
    }) {
      requireString('taskId', taskId);
      requireString('worker', worker);
      requireString('claimToken', claimToken);

      return withTransaction('IMMEDIATE', () => {
        const requeuedAt = now();
        const update = prepare(
          `UPDATE tasks
           SET state = ?,
               lease_owner = NULL,
               claim_token = NULL,
               claim_expires_at = NULL,
               available_at = ?,
               updated_at = ?,
               failed_at = NULL,
               completed_at = NULL
           WHERE task_id = ?
             AND lease_owner = ?
             AND generation = ?
             AND claim_token = ?
             AND state = ?
             AND claim_expires_at >= ?`,
        ).run(
          TASK_STATES.queued,
          availableAt,
          requeuedAt,
          taskId,
          worker,
          generation,
          claimToken,
          TASK_STATES.running,
          requeuedAt,
        );

        if (update.changes !== 1) {
          return null;
        }

        appendEvent('task.requeued', 'task', taskId, {
          taskId,
          worker,
          generation,
          availableAt,
          mode: 'lease-holder',
        });

        return hydrateTask(getTaskRowById(taskId));
      });
    },

    requeueExpiredTasks({ availableAt = now(), excludeClaimTokens = [] } = {}) {
      if (!Array.isArray(excludeClaimTokens)) {
        throw new TypeError('excludeClaimTokens must be an array');
      }
      for (const claimToken of excludeClaimTokens) {
        requireString('excludeClaimTokens[]', claimToken);
      }
      const excludedClaimTokens = new Set(excludeClaimTokens);

      return withTransaction('IMMEDIATE', () => {
        const expiredAt = now();
        const expiredRows = prepare(
          `SELECT task_id, lease_owner, generation, claim_token
           FROM tasks
           WHERE state = ?
             AND claim_expires_at < ?
           ORDER BY claim_expires_at, task_id`,
        ).all(TASK_STATES.running, expiredAt);

        const updates = [];
        for (const row of expiredRows) {
          if (excludedClaimTokens.has(row.claim_token)) {
            continue;
          }

          const update = prepare(
            `UPDATE tasks
             SET state = ?,
                 lease_owner = NULL,
                 claim_token = NULL,
                 claim_expires_at = NULL,
                 available_at = ?,
                 updated_at = ?
             WHERE task_id = ?
               AND generation = ?
               AND claim_token = ?
               AND state = ?
               AND claim_expires_at < ?`,
          ).run(
            TASK_STATES.queued,
            availableAt,
            expiredAt,
            row.task_id,
            row.generation,
            row.claim_token,
            TASK_STATES.running,
            expiredAt,
          );

          if (update.changes === 1) {
            updates.push({
              taskId: row.task_id,
              worker: row.lease_owner,
              generation: row.generation,
            });
            appendEvent('task.requeued', 'task', row.task_id, {
              taskId: row.task_id,
              worker: row.lease_owner,
              generation: row.generation,
              availableAt,
              mode: 'expired',
            });
          }
        }

        return updates;
      });
    },

    retryFailedTask({ taskId, expectedGeneration, availableAt = now(), reason = null }) {
      requireString('taskId', taskId);
      if (!Number.isInteger(expectedGeneration) || expectedGeneration < 0) {
        throw new TypeError('expectedGeneration must be a non-negative integer');
      }

      return withTransaction('IMMEDIATE', () => {
        const retriedAt = now();
        const current = getTaskRowById(taskId);
        if (
          !current
          || current.state !== TASK_STATES.failed
          || current.generation !== expectedGeneration
        ) {
          return null;
        }

        const childRows = listTaskChildRows(taskId);
        const hasChildren = childRows.length > 0;
        const retriableFailedChildren = childRows.filter(
          (childRow) => childRow.state === TASK_STATES.failed,
        );
        const activeChildren = childRows.filter(
          (childRow) => !TERMINAL_TASK_STATES.has(childRow.state),
        );
        const needsChildRecovery = hasChildren
          && (retriableFailedChildren.length > 0 || activeChildren.length > 0);
        const nextGeneration = expectedGeneration + 1;

        if (hasChildren) {
          const currentResult = parseJsonColumn(current.result_json);
          const currentPlan = currentResult?.plan;
          if (!currentPlan || typeof currentPlan !== 'object') {
            throw new TaskConflictError(
              'failed team root cannot be retried without a stored planner result.plan',
              {
                taskId,
                generation: expectedGeneration,
              },
            );
          }
        }

        if (needsChildRecovery) {
          for (const childRow of retriableFailedChildren) {
            const childNextGeneration = childRow.generation + 1;
            const childUpdate = prepare(
              `UPDATE tasks
               SET state = ?,
                   generation = ?,
                   lease_owner = NULL,
                   claim_token = NULL,
                   claim_expires_at = NULL,
                   available_at = ?,
                   updated_at = ?,
                   failed_at = NULL,
                   completed_at = NULL,
                   error_json = NULL,
                   result_json = NULL
               WHERE task_id = ?
                 AND state = ?
                 AND generation = ?`,
            ).run(
              TASK_STATES.queued,
              childNextGeneration,
              availableAt,
              retriedAt,
              childRow.task_id,
              TASK_STATES.failed,
              childRow.generation,
            );
            if (childUpdate.changes !== 1) {
              throw new TaskConflictError('team child retry fence changed during transaction', {
                parentTaskId: taskId,
                taskId: childRow.task_id,
                generation: childRow.generation,
              });
            }

            appendEvent('task.retried', 'task', childRow.task_id, {
              taskId: childRow.task_id,
              previousGeneration: childRow.generation,
              generation: childNextGeneration,
              availableAt,
              reason: `parent/team retry:${taskId}`,
            });
          }
        }

        const update = prepare(
          `UPDATE tasks
           SET state = ?,
               generation = ?,
               lease_owner = NULL,
               claim_token = NULL,
               claim_expires_at = NULL,
               available_at = ?,
               updated_at = ?,
               failed_at = NULL,
               completed_at = NULL,
               error_json = NULL
           WHERE task_id = ?
             AND state = ?
             AND generation = ?`,
        ).run(
          needsChildRecovery ? TASK_STATES.waitingChildren : TASK_STATES.queued,
          nextGeneration,
          availableAt,
          retriedAt,
          taskId,
          TASK_STATES.failed,
          expectedGeneration,
        );
        if (update.changes !== 1) {
          throw new TaskConflictError('task retry fence changed during transaction', {
            taskId,
            generation: expectedGeneration,
          });
        }

        appendEvent('task.retried', 'task', taskId, {
          taskId,
          previousGeneration: expectedGeneration,
          generation: nextGeneration,
          availableAt,
          reason,
        });

        if (needsChildRecovery) {
          appendEvent('task.team-recovery', 'task', taskId, {
            taskId,
            availableAt,
            generation: nextGeneration,
            retriedChildTaskIds: retriableFailedChildren.map((childRow) => childRow.task_id),
            reusedCompletedChildTaskIds: childRows
              .filter((childRow) => childRow.state === TASK_STATES.completed)
              .map((childRow) => childRow.task_id),
            pendingChildTaskIds: activeChildren
              .filter((childRow) => childRow.state === TASK_STATES.queued)
              .map((childRow) => childRow.task_id),
            runningChildTaskIds: activeChildren
              .filter((childRow) => childRow.state === TASK_STATES.running)
              .map((childRow) => childRow.task_id),
          });
        }

        return hydrateTask(getTaskRowById(taskId));
      });
    },

    enqueueOutbox({
      channel,
      payload,
      capacity,
      visibleAt = now(),
      messageId = generateId(),
      taskId,
      worker,
      generation,
      claimToken,
    }) {
      requireString('channel', channel);
      requireString('messageId', messageId);

      if ([taskId, worker, generation, claimToken].some((value) => value !== undefined)) {
        requireString('taskId', taskId);
        requireString('worker', worker);
        requireString('claimToken', claimToken);
        if (!Number.isInteger(generation) || generation <= 0) {
          throw new TypeError('generation must be a positive integer');
        }
      }

      return withTransaction('IMMEDIATE', () => {
        return enqueueOutboxWithinTransaction({
          channel,
          payload,
          capacity,
          visibleAt,
          messageId,
          taskId,
          worker,
          generation,
          claimToken,
        });
      });
    },

    claimOutbox({
      channel,
      consumer,
      limit = 1,
      leaseMs = defaultOutboxLeaseMs,
    }) {
      requireString('channel', channel);
      requireString('consumer', consumer);
      requirePositiveInteger('limit', limit);
      requirePositiveInteger('leaseMs', leaseMs);

      return withTransaction('IMMEDIATE', () => {
        ensureChannelConfigured(channel);
        const leaseNow = now();
        const candidates = prepare(
          `SELECT *
           FROM outbox
           WHERE channel = ?
             AND state != ?
             AND visible_at <= ?
             AND (lease_expires_at IS NULL OR lease_expires_at < ?)
           ORDER BY created_at, message_id
           LIMIT ?`,
        ).all(channel, OUTBOX_STATES.acked, leaseNow, leaseNow, limit);

        const claimed = [];
        for (const candidate of candidates) {
          const generation = candidate.generation + 1;
          const leaseToken = generateId();
          const leaseExpiresAt = leaseNow + leaseMs;
          const update = prepare(
            `UPDATE outbox
             SET state = ?,
                 generation = ?,
                 lease_consumer = ?,
                 lease_token = ?,
                 lease_expires_at = ?,
                 updated_at = ?
             WHERE message_id = ?
               AND state != ?
               AND visible_at <= ?
               AND (lease_expires_at IS NULL OR lease_expires_at < ?)
               AND generation = ?`,
          ).run(
            OUTBOX_STATES.leased,
            generation,
            consumer,
            leaseToken,
            leaseExpiresAt,
            leaseNow,
            candidate.message_id,
            OUTBOX_STATES.acked,
            leaseNow,
            leaseNow,
            candidate.generation,
          );

          if (update.changes !== 1) {
            continue;
          }

          appendEvent('outbox.claimed', 'outbox', candidate.message_id, {
            channel,
            consumer,
            messageId: candidate.message_id,
            generation,
            leaseToken,
            leaseExpiresAt,
          });

          claimed.push(rowToOutboxMessage(getOutboxRowById(candidate.message_id)));
        }

        return claimed;
      });
    },

    ackOutbox({ messageId, consumer, generation, leaseToken }) {
      requireString('messageId', messageId);
      requireString('consumer', consumer);
      requireString('leaseToken', leaseToken);

      return withTransaction('IMMEDIATE', () => {
        const ackedAt = now();
        const update = prepare(
          `UPDATE outbox
           SET state = ?,
               lease_consumer = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               updated_at = ?
           WHERE message_id = ?
             AND lease_consumer = ?
             AND generation = ?
             AND lease_token = ?
             AND state = ?
             AND lease_expires_at >= ?`,
        ).run(
          OUTBOX_STATES.acked,
          ackedAt,
          messageId,
          consumer,
          generation,
          leaseToken,
          OUTBOX_STATES.leased,
          ackedAt,
        );

        if (update.changes !== 1) {
          return false;
        }

        appendEvent('outbox.acked', 'outbox', messageId, {
          messageId,
          consumer,
          generation,
        });
        return true;
      });
    },

    nackOutbox({
      messageId,
      consumer,
      generation,
      leaseToken,
      visibleAt = now(),
    }) {
      requireString('messageId', messageId);
      requireString('consumer', consumer);
      requireString('leaseToken', leaseToken);

      return withTransaction('IMMEDIATE', () => {
        const nackedAt = now();
        const update = prepare(
          `UPDATE outbox
           SET state = ?,
               lease_consumer = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               visible_at = ?,
               updated_at = ?
           WHERE message_id = ?
             AND lease_consumer = ?
             AND generation = ?
             AND lease_token = ?
             AND state = ?
             AND lease_expires_at >= ?`,
        ).run(
          OUTBOX_STATES.pending,
          visibleAt,
          nackedAt,
          messageId,
          consumer,
          generation,
          leaseToken,
          OUTBOX_STATES.leased,
          nackedAt,
        );

        if (update.changes !== 1) {
          return false;
        }

        appendEvent('outbox.nacked', 'outbox', messageId, {
          messageId,
          consumer,
          generation,
          visibleAt,
        });
        return true;
      });
    },

    getOutboxMessage(messageId) {
      return rowToOutboxMessage(getOutboxRowById(messageId));
    },

    listOutbox(filters = {}) {
      const clauses = [];
      const params = [];

      if (filters.channel) {
        requireString('channel', filters.channel);
        clauses.push('channel = ?');
        params.push(filters.channel);
      }
      if (filters.state) {
        requireString('state', filters.state);
        clauses.push('state = ?');
        params.push(filters.state);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = filters.limit ?? 100;
      requirePositiveInteger('limit', limit);

      return prepare(
        `SELECT *
         FROM outbox
         ${where}
         ORDER BY created_at, message_id
         LIMIT ?`,
      )
        .all(...params, limit)
        .map(rowToOutboxMessage);
    },

    getEventHead() {
      const { head, headJson, headSignature } = getHeadMetadata();
      return {
        ...head,
        headJson,
        headSignature,
      };
    },

    listEventLog() {
      return prepare(
        'SELECT seq, occurred_at, kind, entity_type, entity_id, payload_json, prev_hash, entry_hash, signature FROM event_log ORDER BY seq',
      ).all();
    },

    integrityCheck() {
      const row = prepare('PRAGMA integrity_check').get();
      return row?.integrity_check ?? Object.values(row ?? {})[0] ?? 'unknown';
    },

    verifyEventLog() {
      const events = this.listEventLog();
      let previousSeq = 0;
      let previousHash = null;
      let lastSignature = null;

      for (const event of events) {
        if (event.seq !== previousSeq + 1) {
          return {
            ok: false,
            reason: `Non-contiguous event sequence at ${event.seq}`,
          };
        }

        if (event.prev_hash !== previousHash) {
          return {
            ok: false,
            reason: `Prev-hash mismatch at event ${event.seq}`,
          };
        }

        const body = {
          seq: event.seq,
          occurredAt: event.occurred_at,
          kind: event.kind,
          entityType: event.entity_type,
          entityId: event.entity_id,
          payload: canonicalParse(event.payload_json),
          prevHash: event.prev_hash,
        };
        const bodyJson = canonicalStringify(body);
        const expectedSignature = sign(bodyJson);
        if (expectedSignature !== event.signature) {
          return {
            ok: false,
            reason: `Signature mismatch at event ${event.seq}`,
          };
        }

        const expectedHash = sha256Hex(
          canonicalStringify({
            ...body,
            signature: expectedSignature,
          }),
        );
        if (expectedHash !== event.entry_hash) {
          return {
            ok: false,
            reason: `Hash mismatch at event ${event.seq}`,
          };
        }

        previousSeq = event.seq;
        previousHash = event.entry_hash;
        lastSignature = event.signature;
      }

      const { head, headJson, headSignature } = getHeadMetadata();
      const expectedHeadJson = canonicalStringify({
        seq: previousSeq,
        entryHash: previousHash,
        signature: lastSignature,
      });

      if (headJson !== expectedHeadJson) {
        return {
          ok: false,
          reason: 'Head metadata does not match the event log tail',
        };
      }
      if (headSignature !== sign(headJson)) {
        return {
          ok: false,
          reason: 'Head metadata signature mismatch',
        };
      }
      if (
        head.seq !== previousSeq ||
        head.entryHash !== previousHash ||
        head.signature !== lastSignature
      ) {
        return {
          ok: false,
          reason: 'Head metadata payload mismatch',
        };
      }

      return {
        ok: true,
        eventCount: events.length,
        head,
      };
    },
  };
}
