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
  completed: 'completed',
  failed: 'failed',
};

const OUTBOX_STATES = {
  pending: 'pending',
  leased: 'leased',
  acked: 'acked',
};

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

function rowToTask(row) {
  if (!row) {
    return null;
  }

  return {
    taskId: row.task_id,
    key: row.task_key,
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

  function getOutboxRowById(messageId) {
    return prepare('SELECT * FROM outbox WHERE message_id = ?').get(messageId);
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

    getTask(taskId) {
      return hydrateTask(getTaskRowById(taskId));
    },

    getTaskByKey(taskKey) {
      return hydrateTask(getTaskRowByKey(taskKey));
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

    createTask({
      key,
      payload,
      dependencies = [],
      availableAt = now(),
      taskId = generateId(),
    }) {
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
             AND state = ?
             AND claim_expires_at >= ?`,
        ).run(
          claimExpiresAt,
          heartbeatAt,
          taskId,
          worker,
          generation,
          claimToken,
          TASK_STATES.running,
          heartbeatAt,
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

    completeTask({ taskId, worker, generation, claimToken, result = null, outbox = null }) {
      requireString('taskId', taskId);
      requireString('worker', worker);
      requireString('claimToken', claimToken);

      return withTransaction('IMMEDIATE', () => {
        const completedAt = now();
        const resultJson = canonicalStringify(result);

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

        appendEvent('task.completed', 'task', taskId, {
          taskId,
          worker,
          generation,
          resultHash: canonicalHash(result),
        });

        const task = hydrateTask(getTaskRowById(taskId));
        return outbox ? { task, outbox: outboxMessage } : task;
      });
    },

    failTask({ taskId, worker, generation, claimToken, error }) {
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
               result_json = NULL,
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

    requeueExpiredTasks({ availableAt = now() } = {}) {
      return withTransaction('IMMEDIATE', () => {
        const expiredAt = now();
        const expiredRows = prepare(
          `SELECT task_id, lease_owner, generation
           FROM tasks
           WHERE state = ?
             AND claim_expires_at < ?
           ORDER BY claim_expires_at, task_id`,
        ).all(TASK_STATES.running, expiredAt);

        const updates = [];
        for (const row of expiredRows) {
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
               AND state = ?
               AND claim_expires_at < ?`,
          ).run(
            TASK_STATES.queued,
            availableAt,
            expiredAt,
            row.task_id,
            row.generation,
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
        const nextGeneration = expectedGeneration + 1;
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
               error_json = NULL
           WHERE task_id = ?
             AND state = ?
             AND generation = ?`,
        ).run(
          TASK_STATES.queued,
          nextGeneration,
          availableAt,
          retriedAt,
          taskId,
          TASK_STATES.failed,
          expectedGeneration,
        );
        if (update.changes !== 1) return null;

        appendEvent('task.retried', 'task', taskId, {
          taskId,
          previousGeneration: expectedGeneration,
          generation: nextGeneration,
          availableAt,
          reason,
        });
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
