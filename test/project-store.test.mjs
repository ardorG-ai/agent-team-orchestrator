import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import {
  openProjectStore,
  OutboxBackpressureError,
  TaskConflictError,
} from '../src/project-store.mjs';

function createClock(start = 1_000) {
  let current = start;
  return {
    now() {
      return current;
    },
    tick(delta) {
      current += delta;
      return current;
    },
  };
}

function createIdGenerator(prefix) {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

function createStoreHarness(name) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  const dbPath = join(root, 'project-store.sqlite');
  const secretKeyPath = join(root, 'secret.key');
  writeFileSync(secretKeyPath, `${name}-secret`);
  const clock = createClock();
  const generateId = createIdGenerator(name);

  return {
    dbPath,
    secretKeyPath,
    clock,
    open() {
      return openProjectStore({
        dbPath,
        secretKeyPath,
        now: () => clock.now(),
        generateId,
        defaultTaskTtlMs: 50,
        defaultOutboxLeaseMs: 50,
      });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function createLegacyV2Database(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    INSERT INTO schema_migrations(version, applied_at) VALUES(1, 100), (2, 200);

    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE tasks (
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

    CREATE TABLE task_dependencies (
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      PRIMARY KEY (task_id, depends_on_task_id),
      FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
      FOREIGN KEY (depends_on_task_id) REFERENCES tasks(task_id) ON DELETE RESTRICT
    );

    CREATE TABLE event_log (
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

    INSERT INTO tasks(
      task_id,
      task_key,
      payload_json,
      payload_hash,
      state,
      generation,
      available_at,
      created_at,
      updated_at
    ) VALUES(
      'legacy-root',
      'legacy-root',
      '{"legacy":true}',
      'legacy-payload-hash',
      'queued',
      0,
      100,
      100,
      100
    );
  `);
  db.close();
}

test('task claims fence by worker, generation, and claim token across dual handles', () => {
  const harness = createStoreHarness('dual-claim');
  const storeA = harness.open();
  const storeB = harness.open();

  try {
    const created = storeA.createTask({
      key: 'compile',
      payload: { project: 'alpha' },
    }).task;

    assert.equal(storeA.listTasks({ state: 'queued' }).length, 1);

    const claimA = storeA.claimTask({ worker: 'worker-a' });
    assert.equal(claimA.taskId, created.taskId);
    assert.equal(claimA.worker, 'worker-a');
    assert.equal(
      storeA.appendTaskEvent({
        taskId: created.taskId,
        worker: 'worker-a',
        generation: claimA.generation,
        claimToken: claimA.claimToken,
        type: 'worktree-opened',
        payload: { path: '/tmp/worktree-a' },
      }),
      true,
    );
    assert.equal(storeB.claimTask({ worker: 'worker-b' }), null);

    harness.clock.tick(75);
    assert.deepEqual(storeB.requeueExpiredTasks(), [
      {
        taskId: created.taskId,
        worker: 'worker-a',
        generation: 1,
      },
    ]);

    const claimB = storeB.claimTask({
      worker: 'worker-b',
      taskId: created.taskId,
    });
    assert.equal(claimB.generation, 2);
    assert.equal(claimB.worker, 'worker-b');
    assert.equal(
      storeA.appendTaskEvent({
        taskId: created.taskId,
        worker: 'worker-a',
        generation: claimA.generation,
        claimToken: claimA.claimToken,
        type: 'late-log',
        payload: { stale: true },
      }),
      false,
    );

    assert.equal(
      storeA.completeTask({
        taskId: created.taskId,
        worker: 'worker-a',
        generation: claimA.generation,
        claimToken: claimA.claimToken,
        result: { ok: true },
      }),
      null,
    );

    const completed = storeB.completeTask({
      taskId: created.taskId,
      worker: 'worker-b',
      generation: claimB.generation,
      claimToken: claimB.claimToken,
      result: { ok: true },
    });
    assert.equal(completed.state, 'completed');
  } finally {
    storeA.close();
    storeB.close();
    harness.cleanup();
  }
});

test('task creation is idempotent for canonical payload replays and conflicts on drift', () => {
  const harness = createStoreHarness('idempotent');
  const store = harness.open();

  try {
    const created = store.createTask({
      key: 'sync',
      payload: { b: 2, a: 1 },
    });
    const replay = store.createTask({
      key: 'sync',
      payload: { a: 1, b: 2 },
    });

    assert.equal(created.status, 'created');
    assert.equal(replay.status, 'replayed');
    assert.equal(replay.task.taskId, created.task.taskId);

    assert.throws(
      () =>
        store.createTask({
          key: 'sync',
          payload: { a: 1, b: 3 },
        }),
      (error) => error instanceof TaskConflictError,
    );
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('task idempotency includes the dependency set and returns hydrated dependencies', () => {
  const harness = createStoreHarness('idempotent-dependencies');
  const store = harness.open();

  try {
    const first = store.createTask({ key: 'dependency-a', payload: { step: 1 } }).task;
    const second = store.createTask({ key: 'dependency-b', payload: { step: 2 } }).task;
    const created = store.createTask({
      key: 'dependent',
      payload: { step: 3 },
      dependencies: [second.taskId, first.taskId],
    });
    const replay = store.createTask({
      key: 'dependent',
      payload: { step: 3 },
      dependencies: [first.taskId, second.taskId],
    });

    assert.equal(replay.status, 'replayed');
    assert.deepEqual(created.task.dependencies, [first.taskId, second.taskId].sort());
    assert.deepEqual(store.getTask(created.task.taskId).dependencies, created.task.dependencies);
    assert.throws(
      () => store.createTask({
        key: 'dependent',
        payload: { step: 3 },
        dependencies: [first.taskId],
      }),
      (error) => error instanceof TaskConflictError,
    );
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('schema v3 migrates legacy tasks and preserves parent lineage across reopen', () => {
  const harness = createStoreHarness('lineage-migration');
  createLegacyV2Database(harness.dbPath);
  let store = harness.open();

  try {
    const legacy = store.getTask('legacy-root');
    assert.equal(legacy.parentTaskId, null);
    assert.equal(legacy.sliceKey, null);

    const claim = store.claimTask({
      worker: 'legacy-planner',
      taskId: legacy.taskId,
    });
    const { children: [child] } = store.fanOutTask({
      taskId: claim.taskId,
      worker: claim.worker,
      generation: claim.generation,
      claimToken: claim.claimToken,
      result: { migrated: true },
      children: [{
        key: 'legacy-child',
        payload: { step: 'build' },
        sliceKey: 'builder',
      }],
    });
    assert.equal(child.parentTaskId, legacy.taskId);
    assert.equal(child.sliceKey, 'builder');

    store.close();
    store = harness.open();

    assert.deepEqual(
      store.listTaskChildren(legacy.taskId).map((task) => ({
        taskId: task.taskId,
        parentTaskId: task.parentTaskId,
        sliceKey: task.sliceKey,
      })),
      [{
        taskId: child.taskId,
        parentTaskId: legacy.taskId,
        sliceKey: 'builder',
      }],
    );

    const raw = new DatabaseSync(harness.dbPath);
    try {
      assert.deepEqual(
        raw
          .prepare('SELECT version FROM schema_migrations ORDER BY version')
          .all()
          .map((row) => row.version),
        [1, 2, 3],
      );
      assert.equal(
        raw.prepare("SELECT COUNT(*) AS count FROM pragma_foreign_key_list('tasks') WHERE \"from\" = 'parent_task_id' AND \"table\" = 'tasks' AND on_delete = 'RESTRICT'").get().count,
        1,
      );
      const taskIndexes = new Map(
        raw
          .prepare("SELECT name, \"unique\", partial FROM pragma_index_list('tasks')")
          .all()
          .map((row) => [row.name, row]),
      );
      assert.equal(taskIndexes.get('idx_tasks_parent_slice_unique').unique, 1);
      assert.equal(taskIndexes.get('idx_tasks_parent_slice_unique').partial, 1);
      assert.equal(taskIndexes.get('idx_tasks_parent_created').partial, 1);
    } finally {
      raw.close();
    }
  } finally {
    store?.close();
    harness.cleanup();
  }
});

test('generic task creation rejects lineage for queued and terminal parents', () => {
  const harness = createStoreHarness('lineage-entrypoint');
  const store = harness.open();

  try {
    const queuedParent = store.createTask({ key: 'queued-parent', payload: {} }).task;
    const completedParent = store.createTask({ key: 'completed-parent', payload: {} }).task;
    const completedClaim = store.claimTask({
      worker: 'standalone-worker',
      taskId: completedParent.taskId,
    });
    store.completeTask({
      taskId: completedClaim.taskId,
      worker: completedClaim.worker,
      generation: completedClaim.generation,
      claimToken: completedClaim.claimToken,
      result: { done: true },
    });

    for (const parent of [queuedParent, completedParent]) {
      assert.throws(
        () => store.createTask({
          key: `forbidden-child-${parent.key}`,
          payload: {},
          parentTaskId: parent.taskId,
          sliceKey: 'builder',
        }),
        /must be created atomically through fanOutTask/,
      );
      assert.equal(store.listTaskChildren(parent.taskId).length, 0);
    }
    assert.throws(
      () => store.createTask({ key: 'forbidden-parent-only', payload: {}, parentTaskId: null }),
      /must be created atomically through fanOutTask/,
    );
    assert.throws(
      () => store.createTask({ key: 'forbidden-slice-only', payload: {}, sliceKey: undefined }),
      /must be created atomically through fanOutTask/,
    );
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('fanOutTask is the sole lineage writer and preserves unique child lineage across reopen', () => {
  const harness = createStoreHarness('fanout-lineage-reopen');
  let store = harness.open();

  try {
    const parent = store.createTask({ key: 'lineage-parent', payload: {} }).task;
    const claim = store.claimTask({ worker: 'planner', taskId: parent.taskId });
    const created = store.fanOutTask({
      taskId: claim.taskId,
      worker: claim.worker,
      generation: claim.generation,
      claimToken: claim.claimToken,
      result: { plan: 'bounded' },
      children: [
        { taskId: 'lineage-builder-id', key: 'lineage-builder', sliceKey: 'builder', payload: {} },
        { taskId: 'lineage-reviewer-id', key: 'lineage-reviewer', sliceKey: 'reviewer', payload: {}, dependencySliceKeys: ['builder'] },
      ],
    });
    assert.deepEqual(
      created.children.map((child) => [child.key, child.sliceKey, child.parentTaskId]),
      [
        ['lineage-builder', 'builder', parent.taskId],
        ['lineage-reviewer', 'reviewer', parent.taskId],
      ],
    );

    store.close();
    store = harness.open();

    const reopened = store.listTaskChildren(parent.taskId);
    assert.deepEqual(
      reopened.map((child) => [child.key, child.sliceKey, child.parentTaskId]),
      [
        ['lineage-builder', 'builder', parent.taskId],
        ['lineage-reviewer', 'reviewer', parent.taskId],
      ],
    );
    assert.equal(new Set(reopened.map((child) => child.key)).size, reopened.length);
    assert.equal(new Set(reopened.map((child) => child.sliceKey)).size, reopened.length);
    assert.equal(store.verifyEventLog().ok, true);
  } finally {
    store?.close();
    harness.cleanup();
  }
});

test('fanOutTask atomically creates a bounded sibling DAG and fences stale planners', () => {
  const harness = createStoreHarness('fanout-atomic');
  const store = harness.open();

  try {
    const parent = store.createTask({ key: 'team-goal', payload: { goal: 'ship' } }).task;
    const claim = store.claimTask({ worker: 'planner', taskId: parent.taskId, ttlMs: 500 });

    assert.throws(
      () => store.fanOutTask({
        taskId: claim.taskId,
        worker: claim.worker,
        generation: claim.generation,
        claimToken: claim.claimToken,
        result: { planVersion: 1 },
        children: [
          { sliceKey: 'builder', key: 'build', payload: { role: 'builder' }, dependencySliceKeys: ['reviewer'] },
          { sliceKey: 'reviewer', key: 'review', payload: { role: 'reviewer' }, dependencySliceKeys: ['builder'] },
        ],
      }),
      /cycle/i,
    );
    assert.equal(store.listTaskChildren(parent.taskId).length, 0);
    assert.equal(store.getTask(parent.taskId).state, 'running');

    assert.throws(
      () => store.fanOutTask({
        taskId: claim.taskId,
        worker: claim.worker,
        generation: claim.generation,
        claimToken: claim.claimToken,
        result: { planVersion: 1 },
        children: [
          { sliceKey: 'reviewer', key: 'review', payload: {}, dependencySliceKeys: ['missing'] },
        ],
      }),
      /unknown sibling/i,
    );
    assert.equal(store.listTaskChildren(parent.taskId).length, 0);

    const fannedOut = store.fanOutTask({
      taskId: claim.taskId,
      worker: claim.worker,
      generation: claim.generation,
      claimToken: claim.claimToken,
      result: { planVersion: 1, team: { planner: 'codex' } },
      children: [
        { sliceKey: 'builder', key: 'build', payload: { role: 'builder' } },
        { sliceKey: 'researcher', key: 'research', payload: { role: 'researcher' } },
        {
          sliceKey: 'reviewer',
          key: 'review',
          payload: { role: 'reviewer' },
          dependencySliceKeys: ['builder', 'researcher'],
        },
      ],
    });

    assert.equal(fannedOut.parent.state, 'waiting_children');
    assert.equal(fannedOut.parent.worker, null);
    assert.equal(fannedOut.parent.claimToken, null);
    assert.equal(fannedOut.parent.result.planVersion, 1);
    assert.deepEqual(fannedOut.parent.result.team, {
      planner: 'codex',
      phase: 'waiting-children',
      childTaskIds: fannedOut.children.map((task) => task.taskId),
    });
    assert.deepEqual(
      fannedOut.children.map((task) => [task.sliceKey, task.parentTaskId]),
      [
        ['builder', parent.taskId],
        ['researcher', parent.taskId],
        ['reviewer', parent.taskId],
      ],
    );
    const childBySlice = new Map(fannedOut.children.map((task) => [task.sliceKey, task]));
    assert.deepEqual(
      childBySlice.get('reviewer').dependencies,
      [childBySlice.get('builder').taskId, childBySlice.get('researcher').taskId].sort(),
    );

    assert.equal(store.fanOutTask({
      taskId: claim.taskId,
      worker: claim.worker,
      generation: claim.generation,
      claimToken: claim.claimToken,
      result: {},
      children: [{ sliceKey: 'late', key: 'late', payload: {} }],
    }), null);

    const expiredParent = store.createTask({ key: 'expired-team-goal', payload: {} }).task;
    const expiredClaim = store.claimTask({
      worker: 'expired-planner',
      taskId: expiredParent.taskId,
      ttlMs: 50,
    });
    harness.clock.tick(75);
    assert.equal(store.fanOutTask({
      taskId: expiredClaim.taskId,
      worker: expiredClaim.worker,
      generation: expiredClaim.generation,
      claimToken: expiredClaim.claimToken,
      result: {},
      children: [{ sliceKey: 'builder', key: 'expired-builder', payload: {} }],
    }), null);
    assert.equal(store.listTaskChildren(expiredParent.taskId).length, 0);
    assert.equal(store.verifyEventLog().ok, true);
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('fanOutTask rolls back every child and event when any insert conflicts', () => {
  const harness = createStoreHarness('fanout-rollback');
  const store = harness.open();

  try {
    store.createTask({ key: 'occupied-child-key', payload: { existing: true } });
    const parent = store.createTask({ key: 'rollback-parent', payload: {} }).task;
    const claim = store.claimTask({ worker: 'planner', taskId: parent.taskId });
    const beforeEvents = store.listEventLog().length;

    assert.throws(
      () => store.fanOutTask({
        taskId: claim.taskId,
        worker: claim.worker,
        generation: claim.generation,
        claimToken: claim.claimToken,
        result: { shouldNotPersist: true },
        children: [
          { sliceKey: 'builder', key: 'new-child', payload: {} },
          { sliceKey: 'reviewer', key: 'occupied-child-key', payload: {} },
        ],
      }),
      (error) => error instanceof TaskConflictError,
    );

    assert.equal(store.getTaskByKey('new-child'), null);
    assert.equal(store.listTaskChildren(parent.taskId).length, 0);
    assert.equal(store.getTask(parent.taskId).state, 'running');
    assert.equal(store.listEventLog().length, beforeEvents);
    assert.equal(store.verifyEventLog().ok, true);
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('child completion wakes the parent only after every direct child is terminal', () => {
  const harness = createStoreHarness('fanout-join');
  const store = harness.open();

  try {
    const parent = store.createTask({ key: 'join-parent', payload: {} }).task;
    const planner = store.claimTask({ worker: 'planner', taskId: parent.taskId });
    const { children } = store.fanOutTask({
      taskId: planner.taskId,
      worker: planner.worker,
      generation: planner.generation,
      claimToken: planner.claimToken,
      result: { plan: 'fixed' },
      children: [
        { sliceKey: 'builder', key: 'join-builder', payload: {} },
        { sliceKey: 'researcher', key: 'join-researcher', payload: {} },
      ],
    });
    const [builder, researcher] = children;

    assert.equal(store.completeTask({
      taskId: parent.taskId,
      worker: planner.worker,
      generation: planner.generation,
      claimToken: planner.claimToken,
      result: { invalid: true },
    }), null);

    const builderClaim = store.claimTask({ worker: 'builder', taskId: builder.taskId });
    store.completeTask({
      taskId: builderClaim.taskId,
      worker: builderClaim.worker,
      generation: builderClaim.generation,
      claimToken: builderClaim.claimToken,
      result: { candidateOid: 'a'.repeat(40) },
    });
    assert.equal(store.getTask(parent.taskId).state, 'waiting_children');

    const researcherClaim = store.claimTask({ worker: 'researcher', taskId: researcher.taskId });
    store.completeTask({
      taskId: researcherClaim.taskId,
      worker: researcherClaim.worker,
      generation: researcherClaim.generation,
      claimToken: researcherClaim.claimToken,
      result: { report: 'done' },
    });

    const awakened = store.getTask(parent.taskId);
    assert.equal(awakened.state, 'queued');
    assert.equal(awakened.result.plan, 'fixed');
    assert.equal(
      store.listEventLog().filter((event) => event.kind === 'task.children-settled').length,
      1,
    );

    const parentClaim = store.claimTask({ worker: 'supervisor', taskId: parent.taskId });
    const completed = store.completeTask({
      taskId: parentClaim.taskId,
      worker: parentClaim.worker,
      generation: parentClaim.generation,
      claimToken: parentClaim.claimToken,
      result: { verdict: 'complete' },
    });
    assert.equal(completed.state, 'completed');
    assert.equal(store.verifyEventLog().ok, true);
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('failed children recursively fail queued dependency descendants and wake affected parents', () => {
  const harness = createStoreHarness('fanout-failure-join');
  const store = harness.open();

  try {
    const parent = store.createTask({ key: 'failure-parent', payload: {} }).task;
    const planner = store.claimTask({ worker: 'planner', taskId: parent.taskId });
    const { children } = store.fanOutTask({
      taskId: planner.taskId,
      worker: planner.worker,
      generation: planner.generation,
      claimToken: planner.claimToken,
      result: { plan: 'failure-path' },
      children: [
        { sliceKey: 'builder', key: 'failure-builder', payload: {} },
        {
          sliceKey: 'reviewer',
          key: 'failure-reviewer',
          payload: {},
          dependencySliceKeys: ['builder'],
        },
        {
          sliceKey: 'verifier',
          key: 'failure-verifier',
          payload: {},
          dependencySliceKeys: ['reviewer'],
        },
      ],
    });
    const childBySlice = new Map(children.map((task) => [task.sliceKey, task]));
    const builderClaim = store.claimTask({
      worker: 'builder',
      taskId: childBySlice.get('builder').taskId,
    });
    store.failTask({
      taskId: builderClaim.taskId,
      worker: builderClaim.worker,
      generation: builderClaim.generation,
      claimToken: builderClaim.claimToken,
      error: new Error('build failed'),
    });

    const reviewer = store.getTask(childBySlice.get('reviewer').taskId);
    const verifier = store.getTask(childBySlice.get('verifier').taskId);
    assert.equal(reviewer.state, 'failed');
    assert.equal(reviewer.error.code, 'dependency_failed');
    assert.equal(reviewer.error.dependencyTaskId, builderClaim.taskId);
    assert.equal(verifier.state, 'failed');
    assert.equal(verifier.error.code, 'dependency_failed');
    assert.equal(verifier.error.dependencyTaskId, reviewer.taskId);
    assert.equal(store.getTask(parent.taskId).state, 'queued');
    assert.equal(
      store.listEventLog().filter((event) => event.kind === 'task.children-settled').length,
      1,
    );
    assert.equal(store.verifyEventLog().ok, true);
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('dependency gating blocks direct child claims until prerequisites finish', () => {
  const harness = createStoreHarness('deps');
  const store = harness.open();

  try {
    const prepareTask = store.createTask({
      key: 'prepare',
      payload: { step: 1 },
    }).task;
    const publishTask = store.createTask({
      key: 'publish',
      payload: { step: 2 },
      dependencies: [prepareTask.taskId],
    }).task;

    assert.equal(
      store.claimTask({
        worker: 'worker-child',
        taskId: publishTask.taskId,
      }),
      null,
    );

    const parentClaim = store.claimTask({ worker: 'worker-parent' });
    assert.equal(parentClaim.taskId, prepareTask.taskId);
    assert.equal(store.claimTask({ worker: 'worker-child' }), null);

    store.completeTask({
      taskId: parentClaim.taskId,
      worker: 'worker-parent',
      generation: parentClaim.generation,
      claimToken: parentClaim.claimToken,
      result: { prepared: true },
    });

    const childClaim = store.claimTask({
      worker: 'worker-child',
      taskId: publishTask.taskId,
    });
    assert.equal(childClaim.taskId, publishTask.taskId);
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('claimTask skips tasks whose target channel is already at capacity', () => {
  const harness = createStoreHarness('claim-channel-capacity');
  const store = harness.open();

  try {
    store.configureChannel({
      channel: 'events',
      capacity: 1,
    });
    store.enqueueOutbox({
      channel: 'events',
      payload: { queued: true },
    });

    const blockedTask = store.createTask({
      key: 'dispatch-events',
      payload: { channel: 'events', job: 'blocked' },
    }).task;
    const freeTask = store.createTask({
      key: 'dispatch-metrics',
      payload: { channel: 'metrics', job: 'free' },
    }).task;

    const claim = store.claimTask({ worker: 'worker-dispatch' });
    assert.equal(claim.taskId, freeTask.taskId);
    assert.equal(
      store.claimTask({
        worker: 'worker-dispatch',
        taskId: blockedTask.taskId,
      }),
      null,
    );
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('claimTask does not starve runnable work behind more than 100 saturated tasks', () => {
  const harness = createStoreHarness('claim-channel-starvation');
  const store = harness.open();

  try {
    store.configureChannel({ channel: 'blocked', capacity: 1 });
    store.enqueueOutbox({ channel: 'blocked', payload: { occupied: true } });

    for (let index = 0; index < 101; index += 1) {
      store.createTask({
        key: `blocked-${String(index).padStart(3, '0')}`,
        payload: { channel: 'blocked', index },
      });
    }
    const runnable = store.createTask({
      key: 'runnable-after-blocked-page',
      payload: { channel: 'free' },
    }).task;

    const claim = store.claimTask({ worker: 'worker-runnable' });
    assert.equal(claim.taskId, runnable.taskId);
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('heartbeat and lease-holder requeue reject stale or wrong workers', () => {
  const harness = createStoreHarness('heartbeat');
  const store = harness.open();

  try {
    const task = store.createTask({
      key: 'render',
      payload: { frame: 1 },
    }).task;
    const claim = store.claimTask({ worker: 'worker-a' });

    assert.equal(
      store.heartbeatTask({
        taskId: task.taskId,
        worker: 'worker-b',
        generation: claim.generation,
        claimToken: claim.claimToken,
      }),
      null,
    );

    harness.clock.tick(60);

    assert.equal(
      store.heartbeatTask({
        taskId: task.taskId,
        worker: 'worker-a',
        generation: claim.generation,
        claimToken: claim.claimToken,
      }),
      null,
    );
    assert.equal(
      store.requeueTaskLease({
        taskId: task.taskId,
        worker: 'worker-a',
        generation: claim.generation,
        claimToken: claim.claimToken,
      }),
      null,
    );
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('outbox capacity is persisted per channel and stale acks are rejected after reclaim', () => {
  const harness = createStoreHarness('outbox');
  const storeA = harness.open();
  const storeB = harness.open();

  try {
    const configured = storeA.configureChannel({
      channel: 'events',
      capacity: 2,
    });
    assert.equal(configured.capacity, 2);
    assert.equal(storeB.getChannel('events').capacity, 2);

    const first = storeA.enqueueOutbox({
      channel: 'events',
      payload: { order: 1 },
    });
    storeA.enqueueOutbox({
      channel: 'events',
      payload: { order: 2 },
    });

    assert.deepEqual(storeA.listChannels(), [
      {
        channel: 'events',
        capacity: 2,
        createdAt: configured.createdAt,
        updatedAt: configured.updatedAt,
        pendingDepth: 2,
      },
    ]);

    assert.throws(
      () =>
        storeA.enqueueOutbox({
          channel: 'events',
          payload: { order: 3 },
        }),
      (error) => error instanceof OutboxBackpressureError,
    );

    const [leaseA] = storeA.claimOutbox({
      channel: 'events',
      consumer: 'consumer-a',
    });
    assert.equal(leaseA.messageId, first.messageId);
    assert.equal(leaseA.consumer, 'consumer-a');

    harness.clock.tick(75);
    const [leaseB] = storeB.claimOutbox({
      channel: 'events',
      consumer: 'consumer-b',
    });
    assert.equal(leaseB.messageId, first.messageId);
    assert.equal(leaseB.generation, leaseA.generation + 1);
    assert.equal(leaseB.consumer, 'consumer-b');

    assert.equal(
      storeA.ackOutbox({
        messageId: first.messageId,
        consumer: 'consumer-a',
        generation: leaseA.generation,
        leaseToken: leaseA.leaseToken,
      }),
      false,
    );
    assert.equal(
      storeB.ackOutbox({
        messageId: first.messageId,
        consumer: 'consumer-a',
        generation: leaseB.generation,
        leaseToken: leaseB.leaseToken,
      }),
      false,
    );
    assert.equal(
      storeB.nackOutbox({
        messageId: first.messageId,
        consumer: 'consumer-b',
        generation: leaseB.generation,
        leaseToken: leaseB.leaseToken,
        visibleAt: harness.clock.now() + 10,
      }),
      true,
    );
  } finally {
    storeA.close();
    storeB.close();
    harness.cleanup();
  }
});

test('outbox message ids replay identical writes and reject payload drift', () => {
  const harness = createStoreHarness('outbox-idempotency');
  const store = harness.open();

  try {
    store.configureChannel({ channel: 'review', capacity: 1 });
    const first = store.enqueueOutbox({
      channel: 'review',
      messageId: 'review-1',
      payload: { taskId: 'task-1', status: 'ready' },
    });
    const replay = store.enqueueOutbox({
      channel: 'review',
      messageId: 'review-1',
      payload: { status: 'ready', taskId: 'task-1' },
    });

    assert.deepEqual(replay, first);
    assert.throws(
      () => store.enqueueOutbox({
        channel: 'review',
        messageId: 'review-1',
        payload: { taskId: 'task-1', status: 'changed' },
      }),
      (error) => error instanceof TaskConflictError,
    );
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('task-scoped outbox writes reject stale task fences', () => {
  const harness = createStoreHarness('outbox-task-fence');
  const store = harness.open();

  try {
    store.configureChannel({ channel: 'review', capacity: 5 });
    const task = store.createTask({
      key: 'builder-task',
      payload: { channel: 'review' },
    }).task;
    const first = store.claimTask({ worker: 'builder-a', taskId: task.taskId, ttlMs: 50 });
    store.enqueueOutbox({
      channel: 'review',
      messageId: 'candidate-1',
      payload: { candidateOid: 'a'.repeat(40) },
      taskId: first.taskId,
      worker: first.worker,
      generation: first.generation,
      claimToken: first.claimToken,
    });

    harness.clock.tick(75);
    store.requeueExpiredTasks();
    const second = store.claimTask({ worker: 'builder-b', taskId: task.taskId, ttlMs: 50 });
    assert.equal(second.generation, first.generation + 1);

    assert.throws(
      () => store.enqueueOutbox({
        channel: 'review',
        messageId: 'candidate-stale',
        payload: { candidateOid: 'b'.repeat(40) },
        taskId: first.taskId,
        worker: first.worker,
        generation: first.generation,
        claimToken: first.claimToken,
      }),
      (error) => error instanceof TaskConflictError,
    );
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('task completion and required outbox publication commit atomically', () => {
  const harness = createStoreHarness('complete-with-outbox');
  const store = harness.open();

  try {
    store.configureChannel({ channel: 'review', capacity: 1 });
    const blocker = store.enqueueOutbox({
      channel: 'review',
      messageId: 'existing-review',
      payload: { occupied: true },
    });
    const task = store.createTask({ key: 'atomic-finish', payload: { title: 'finish' } }).task;
    const claim = store.claimTask({ worker: 'builder', taskId: task.taskId, ttlMs: 500 });

    assert.throws(
      () => store.completeTask({
        taskId: claim.taskId,
        worker: claim.worker,
        generation: claim.generation,
        claimToken: claim.claimToken,
        result: { candidateOid: 'a'.repeat(40) },
        outbox: {
          channel: 'review',
          messageId: 'candidate-ready',
          payload: { taskId: claim.taskId },
        },
      }),
      (error) => error instanceof OutboxBackpressureError,
    );
    assert.equal(store.getTask(task.taskId).state, 'running');
    assert.equal(store.getOutboxMessage('candidate-ready'), null);

    const [leased] = store.claimOutbox({ channel: 'review', consumer: 'reviewer' });
    assert.equal(leased.messageId, blocker.messageId);
    assert.equal(store.ackOutbox({
      messageId: leased.messageId,
      consumer: leased.consumer,
      generation: leased.generation,
      leaseToken: leased.leaseToken,
    }), true);

    const completed = store.completeTask({
      taskId: claim.taskId,
      worker: claim.worker,
      generation: claim.generation,
      claimToken: claim.claimToken,
      result: { candidateOid: 'a'.repeat(40) },
      outbox: {
        channel: 'review',
        messageId: 'candidate-ready',
        payload: { taskId: claim.taskId },
      },
    });
    assert.equal(completed.task.state, 'completed');
    assert.equal(completed.outbox.messageId, 'candidate-ready');
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('failed tasks require an expected generation for explicit retry', () => {
  const harness = createStoreHarness('retry-failed');
  const store = harness.open();

  try {
    const task = store.createTask({ key: 'retry-me', payload: { title: 'retry' } }).task;
    const claim = store.claimTask({ worker: 'builder', taskId: task.taskId, ttlMs: 100 });
    const failed = store.failTask({
      taskId: claim.taskId,
      worker: claim.worker,
      generation: claim.generation,
      claimToken: claim.claimToken,
      error: new Error('test failure'),
    });
    assert.equal(failed.state, 'failed');
    assert.equal(store.retryFailedTask({
      taskId: failed.taskId,
      expectedGeneration: failed.generation - 1,
      reason: 'stale operator view',
    }), null);

    const retried = store.retryFailedTask({
      taskId: failed.taskId,
      expectedGeneration: failed.generation,
      reason: 'fixed input',
    });
    assert.equal(retried.state, 'queued');
    assert.equal(retried.generation, failed.generation + 1);
    assert.equal(store.integrityCheck(), 'ok');
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('retryFailedTask preserves planner results and atomically requeues failed direct children for team recovery', () => {
  const harness = createStoreHarness('retry-team-recovery');
  const store = harness.open();

  try {
    const parent = store.createTask({
      key: 'retry-team-parent',
      payload: {
        adapter: 'codex',
        executionMode: 'planner',
        role: 'planner',
        scope: ['src/', 'test/'],
        title: 'Recover a failed team aggregate',
      },
    }).task;
    const planner = store.claimTask({ worker: 'planner', taskId: parent.taskId });
    const plannerResult = {
      plan: {
        schema: 'team.plan.v1',
        summary: 'Recover the existing child graph without creating new slices.',
        assumptions: [],
        acceptanceCriteria: [{ id: 'ac-1', text: 'Recovery reuses the existing child DAG.' }],
        lanes: {
          builder: { objective: 'Repair the implementation.', scope: ['src/'] },
          researcher: { objective: 'Summarize constraints.', scope: [] },
          test: { objective: 'Report required coverage.', scope: ['test/'] },
        },
        requiredChecks: ['npm test'],
      },
      team: { planner: 'codex' },
    };
    const { children } = store.fanOutTask({
      taskId: planner.taskId,
      worker: planner.worker,
      generation: planner.generation,
      claimToken: planner.claimToken,
      result: plannerResult,
      children: [
        { sliceKey: 'builder', key: 'retry-team-builder', payload: { role: 'builder' } },
        { sliceKey: 'researcher', key: 'retry-team-researcher', payload: { role: 'researcher' } },
        { sliceKey: 'test', key: 'retry-team-test', payload: { role: 'test' } },
        {
          sliceKey: 'reviewer',
          key: 'retry-team-reviewer',
          payload: { role: 'reviewer' },
          dependencySliceKeys: ['builder', 'researcher', 'test'],
        },
        {
          sliceKey: 'verifier',
          key: 'retry-team-verifier',
          payload: { role: 'verifier' },
          dependencySliceKeys: ['reviewer'],
        },
      ],
    });
    const childBySlice = Object.fromEntries(children.map((child) => [child.sliceKey, child]));

    const builderClaim = store.claimTask({
      worker: 'builder',
      taskId: childBySlice.builder.taskId,
    });
    store.failTask({
      taskId: builderClaim.taskId,
      worker: builderClaim.worker,
      generation: builderClaim.generation,
      claimToken: builderClaim.claimToken,
      error: new Error('builder failed'),
    });

    const researcherClaim = store.claimTask({
      worker: 'researcher',
      taskId: childBySlice.researcher.taskId,
    });
    store.completeTask({
      taskId: researcherClaim.taskId,
      worker: researcherClaim.worker,
      generation: researcherClaim.generation,
      claimToken: researcherClaim.claimToken,
      result: { finalMessage: 'research complete' },
    });

    const testClaim = store.claimTask({
      worker: 'tester',
      taskId: childBySlice.test.taskId,
    });
    store.completeTask({
      taskId: testClaim.taskId,
      worker: testClaim.worker,
      generation: testClaim.generation,
      claimToken: testClaim.claimToken,
      result: { finalMessage: 'tests complete' },
    });

    assert.equal(store.getTask(parent.taskId).state, 'queued');
    const aggregateClaim = store.claimTask({
      worker: 'aggregate',
      taskId: parent.taskId,
    });
    const failedParent = store.failTask({
      taskId: aggregateClaim.taskId,
      worker: aggregateClaim.worker,
      generation: aggregateClaim.generation,
      claimToken: aggregateClaim.claimToken,
      error: new Error('team child failure: builder'),
      preserveResult: true,
    });
    assert.equal(failedParent.state, 'failed');
    assert.deepEqual(failedParent.result.plan, plannerResult.plan);

    const retried = store.retryFailedTask({
      taskId: failedParent.taskId,
      expectedGeneration: failedParent.generation,
      reason: 'operator requested team recovery',
    });
    assert.equal(retried.state, 'waiting_children');
    assert.equal(retried.generation, failedParent.generation + 1);
    assert.deepEqual(retried.result.plan, plannerResult.plan);
    assert.equal(retried.error, null);
    assert.equal(retried.failedAt, null);

    const retriedBuilder = store.getTask(childBySlice.builder.taskId);
    const retriedReviewer = store.getTask(childBySlice.reviewer.taskId);
    const retriedVerifier = store.getTask(childBySlice.verifier.taskId);
    const completedResearcher = store.getTask(childBySlice.researcher.taskId);
    const completedTester = store.getTask(childBySlice.test.taskId);

    assert.equal(retriedBuilder.state, 'queued');
    assert.equal(retriedBuilder.generation, 2);
    assert.equal(retriedBuilder.error, null);
    assert.equal(retriedBuilder.result, null);
    assert.equal(retriedBuilder.failedAt, null);

    for (const task of [retriedReviewer, retriedVerifier]) {
      assert.equal(task.state, 'queued');
      assert.equal(task.generation, 1);
      assert.equal(task.error, null);
      assert.equal(task.result, null);
      assert.equal(task.failedAt, null);
    }
    assert.equal(completedResearcher.state, 'completed');
    assert.equal(completedResearcher.generation, 1);
    assert.equal(completedTester.state, 'completed');
    assert.equal(completedTester.generation, 1);

    const retriedEvents = store
      .listEventLog()
      .filter((event) => event.kind === 'task.retried')
      .map((event) => JSON.parse(event.payload_json));
    assert.equal(retriedEvents.length, 4);
    assert.deepEqual(
      retriedEvents.map((event) => [event.taskId, event.reason]).sort((a, b) => a[0].localeCompare(b[0])),
      [
        [parent.taskId, 'operator requested team recovery'],
        [childBySlice.builder.taskId, `parent/team retry:${parent.taskId}`],
        [childBySlice.reviewer.taskId, `parent/team retry:${parent.taskId}`],
        [childBySlice.verifier.taskId, `parent/team retry:${parent.taskId}`],
      ],
    );
    assert.equal(store.verifyEventLog().ok, true);
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('retryFailedTask requeues only the failed team root when every direct child already completed', () => {
  const harness = createStoreHarness('retry-team-root-only');
  const store = harness.open();

  try {
    const parent = store.createTask({
      key: 'retry-team-root-only-parent',
      payload: {
        adapter: 'codex',
        executionMode: 'planner',
        role: 'planner',
        title: 'Retry only the aggregate step.',
      },
    }).task;
    const planner = store.claimTask({ worker: 'planner', taskId: parent.taskId });
    const plannerResult = {
      plan: {
        schema: 'team.plan.v1',
        summary: 'Aggregate existing completed children without another fan-out.',
        assumptions: [],
        acceptanceCriteria: [{ id: 'ac-1', text: 'Retry keeps the existing child DAG intact.' }],
        lanes: {
          builder: { objective: 'Ship code', scope: ['src/'] },
          reviewer: { objective: 'Review candidate', scope: [] },
        },
        requiredChecks: ['npm test'],
      },
      team: { planner: 'codex' },
    };
    const { children } = store.fanOutTask({
      taskId: planner.taskId,
      worker: planner.worker,
      generation: planner.generation,
      claimToken: planner.claimToken,
      result: plannerResult,
      children: [
        { sliceKey: 'builder', key: 'retry-team-root-only-builder', payload: { role: 'builder' } },
        {
          sliceKey: 'reviewer',
          key: 'retry-team-root-only-reviewer',
          payload: { role: 'reviewer' },
          dependencySliceKeys: ['builder'],
        },
      ],
    });

    for (const child of children) {
      const claim = store.claimTask({ worker: `${child.sliceKey}-worker`, taskId: child.taskId });
      store.completeTask({
        taskId: claim.taskId,
        worker: claim.worker,
        generation: claim.generation,
        claimToken: claim.claimToken,
        result: { finalMessage: `${child.sliceKey} done` },
      });
    }

    const childSnapshots = Object.fromEntries(
      children.map((child) => [child.taskId, store.getTask(child.taskId)]),
    );
    assert.equal(store.getTask(parent.taskId).state, 'queued');

    const aggregateClaim = store.claimTask({ worker: 'aggregate', taskId: parent.taskId });
    const failedParent = store.failTask({
      taskId: aggregateClaim.taskId,
      worker: aggregateClaim.worker,
      generation: aggregateClaim.generation,
      claimToken: aggregateClaim.claimToken,
      error: new Error('aggregate interrupted'),
      preserveResult: true,
    });

    const retried = store.retryFailedTask({
      taskId: failedParent.taskId,
      expectedGeneration: failedParent.generation,
      reason: 'retry aggregate only',
    });
    assert.equal(retried.state, 'queued');
    assert.deepEqual(retried.result.plan, plannerResult.plan);

    for (const child of children) {
      assert.deepEqual(store.getTask(child.taskId), childSnapshots[child.taskId]);
    }

    const teamRecoveryEvents = store
      .listEventLog()
      .filter((event) => event.kind === 'task.team-recovery');
    assert.equal(teamRecoveryEvents.length, 0);

    const retriedEvents = store
      .listEventLog()
      .filter((event) => event.kind === 'task.retried')
      .map((event) => JSON.parse(event.payload_json));
    assert.deepEqual(
      retriedEvents.map((event) => [event.taskId, event.reason]),
      [[parent.taskId, 'retry aggregate only']],
    );
    assert.equal(store.verifyEventLog().ok, true);
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('retryFailedTask rejects failed team roots that still have children but lost result.plan', () => {
  const harness = createStoreHarness('retry-team-missing-plan');
  const store = harness.open();

  try {
    const parent = store.createTask({
      key: 'retry-missing-plan-parent',
      payload: {
        adapter: 'codex',
        executionMode: 'planner',
        role: 'planner',
      },
    }).task;
    const planner = store.claimTask({ worker: 'planner', taskId: parent.taskId });
    const { children } = store.fanOutTask({
      taskId: planner.taskId,
      worker: planner.worker,
      generation: planner.generation,
      claimToken: planner.claimToken,
      result: { team: { planner: 'codex' } },
      children: [
        { sliceKey: 'builder', key: 'retry-missing-plan-builder', payload: { role: 'builder' } },
      ],
    });
    const child = children[0];
    const childClaim = store.claimTask({ worker: 'builder', taskId: child.taskId });
    store.completeTask({
      taskId: childClaim.taskId,
      worker: childClaim.worker,
      generation: childClaim.generation,
      claimToken: childClaim.claimToken,
      result: { finalMessage: 'done' },
    });

    const aggregateClaim = store.claimTask({ worker: 'aggregate', taskId: parent.taskId });
    const failedParent = store.failTask({
      taskId: aggregateClaim.taskId,
      worker: aggregateClaim.worker,
      generation: aggregateClaim.generation,
      claimToken: aggregateClaim.claimToken,
      error: new Error('aggregate missing plan'),
      preserveResult: true,
    });
    const beforeParent = store.getTask(parent.taskId);
    const beforeChild = store.getTask(child.taskId);
    const eventCount = store.listEventLog().length;

    assert.throws(
      () => store.retryFailedTask({
        taskId: failedParent.taskId,
        expectedGeneration: failedParent.generation,
        reason: 'retry without planner plan',
      }),
      TaskConflictError,
    );
    assert.deepEqual(store.getTask(parent.taskId), beforeParent);
    assert.deepEqual(store.getTask(child.taskId), beforeChild);
    assert.equal(store.listEventLog().length, eventCount);
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('retryFailedTask keeps a failed team root waiting for non-terminal direct children and fanOutTask rejects a second lineage write', () => {
  const harness = createStoreHarness('retry-team-waiting-child');
  const store = harness.open();

  try {
    const parent = store.createTask({
      key: 'retry-waiting-child-parent',
      payload: {
        adapter: 'codex',
        executionMode: 'planner',
        role: 'planner',
      },
    }).task;
    const planner = store.claimTask({ worker: 'planner', taskId: parent.taskId, ttlMs: 500 });
    const parentResult = {
      plan: {
        schema: 'team.plan.v1',
        summary: 'A direct child still owns nested work.',
        assumptions: [],
        acceptanceCriteria: [{ id: 'ac-1', text: 'Do not aggregate while a direct child is non-terminal.' }],
        lanes: {
          builder: { objective: 'Drive nested work', scope: ['src/'] },
          researcher: { objective: 'Report later', scope: [] },
        },
        requiredChecks: [],
      },
      team: { planner: 'codex' },
    };
    const rootFanOut = store.fanOutTask({
      taskId: planner.taskId,
      worker: planner.worker,
      generation: planner.generation,
      claimToken: planner.claimToken,
      result: parentResult,
      children: [
        { sliceKey: 'builder', key: 'retry-waiting-child-builder', payload: { role: 'planner' } },
        {
          sliceKey: 'researcher',
          key: 'retry-waiting-child-researcher',
          payload: { role: 'researcher' },
        },
      ],
    });
    const childBySlice = Object.fromEntries(rootFanOut.children.map((child) => [child.sliceKey, child]));

    const builderClaim = store.claimTask({
      worker: 'builder-planner',
      taskId: childBySlice.builder.taskId,
      ttlMs: 500,
    });
    store.fanOutTask({
      taskId: builderClaim.taskId,
      worker: builderClaim.worker,
      generation: builderClaim.generation,
      claimToken: builderClaim.claimToken,
      result: {
        plan: {
          schema: 'team.plan.v1',
          summary: 'Nested direct child work.',
          assumptions: [],
          acceptanceCriteria: [{ id: 'nested-1', text: 'Nested child remains active.' }],
          lanes: {
            implementer: { objective: 'Do nested work', scope: ['src/'] },
          },
          requiredChecks: [],
        },
        team: { planner: 'codex' },
      },
      children: [
        { sliceKey: 'implementer', key: 'retry-waiting-grandchild', payload: { role: 'builder' } },
      ],
    });

    const researcherClaim = store.claimTask({ worker: 'researcher', taskId: childBySlice.researcher.taskId });
    store.completeTask({
      taskId: researcherClaim.taskId,
      worker: researcherClaim.worker,
      generation: researcherClaim.generation,
      claimToken: researcherClaim.claimToken,
      result: { finalMessage: 'research completed while builder subtree kept running' },
    });

    const db = new DatabaseSync(harness.dbPath);
    try {
      db.prepare(
        `UPDATE tasks
         SET state = ?, generation = ?, lease_owner = NULL, claim_token = NULL, claim_expires_at = NULL,
             available_at = ?, updated_at = ?, failed_at = ?, completed_at = NULL,
             error_json = ?, result_json = ?
         WHERE task_id = ?`,
      ).run(
        'failed',
        1,
        harness.clock.now(),
        harness.clock.now(),
        harness.clock.now(),
        JSON.stringify({ message: 'aggregate resumed too early' }),
        JSON.stringify(store.getTask(parent.taskId).result),
        parent.taskId,
      );
      db.prepare(
        `UPDATE tasks
         SET state = ?, lease_owner = ?, claim_token = ?, claim_expires_at = ?, updated_at = ?
         WHERE task_id = ?`,
      ).run(
        'running',
        planner.worker,
        planner.claimToken,
        harness.clock.now() + 500,
        harness.clock.now(),
        parent.taskId,
      );
    } finally {
      db.close();
    }

    const beforeChildren = store.listTaskChildren(parent.taskId).map((task) => task.taskId);
    assert.throws(
      () => store.fanOutTask({
        taskId: parent.taskId,
        worker: planner.worker,
        generation: planner.generation,
        claimToken: planner.claimToken,
        result: parentResult,
        children: [
          { sliceKey: 'builder', key: 'retry-waiting-child-builder-retry', payload: { role: 'builder' } },
        ],
      }),
      /already has direct children/i,
    );
    assert.deepEqual(store.listTaskChildren(parent.taskId).map((task) => task.taskId), beforeChildren);

    const retryDb = new DatabaseSync(harness.dbPath);
    try {
      retryDb.prepare(
        `UPDATE tasks
         SET state = ?, lease_owner = NULL, claim_token = NULL, claim_expires_at = NULL,
             updated_at = ?, failed_at = ?
         WHERE task_id = ?`,
      ).run(
        'failed',
        harness.clock.now(),
        harness.clock.now(),
        parent.taskId,
      );
    } finally {
      retryDb.close();
    }

    const failedParent = store.getTask(parent.taskId);
    const retried = store.retryFailedTask({
      taskId: failedParent.taskId,
      expectedGeneration: failedParent.generation,
      reason: 'wait for nested child tree',
    });
    assert.equal(retried.state, 'waiting_children');
    assert.equal(store.getTask(childBySlice.builder.taskId).state, 'waiting_children');
    assert.equal(store.getTask(childBySlice.researcher.taskId).state, 'completed');

    const retriedEvents = store
      .listEventLog()
      .filter((event) => event.kind === 'task.retried')
      .map((event) => JSON.parse(event.payload_json));
    assert.deepEqual(
      retriedEvents.map((event) => [event.taskId, event.reason]),
      [[parent.taskId, 'wait for nested child tree']],
    );
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('project assets are insert-only revisions with replay semantics and redacted audit events', () => {
  const harness = createStoreHarness('project-assets');
  const store = harness.open();

  try {
    const created = store.createProjectAsset({
      assetKey: 'memory/brief',
      kind: 'memory',
      memoryLayer: 'l1',
      title: 'Alpha brief',
      contentText: 'Remember the alpha constraints.',
      source: { z: 2, a: 1 },
      expectedRevision: 0,
    });
    const replay = store.createProjectAsset({
      assetKey: 'memory/brief',
      kind: 'memory',
      memoryLayer: 'l1',
      title: 'Alpha brief',
      contentText: 'Remember the alpha constraints.',
      source: { a: 1, z: 2 },
      expectedRevision: 0,
    });
    const revisionTwo = store.createProjectAsset({
      assetKey: 'memory/brief',
      kind: 'memory',
      memoryLayer: 'l1',
      title: 'Alpha brief v2',
      contentText: 'Remember the alpha constraints and beta risks.',
      source: { source: 'controller' },
      expectedRevision: 1,
    });

    assert.equal(created.status, 'created');
    assert.equal(created.asset.revision, 1);
    assert.equal(replay.status, 'replayed');
    assert.equal(replay.asset.assetId, created.asset.assetId);
    assert.equal(revisionTwo.asset.revision, 2);
    assert.equal(store.getProjectAsset(created.asset.assetId).assetId, created.asset.assetId);
    assert.equal(store.getProjectAsset({ assetKey: 'memory/brief' }).revision, 2);
    assert.deepEqual(
      store.listProjectAssets({ keyPrefix: 'memory/' }).map((asset) => asset.revision),
      [2, 1],
    );

    assert.throws(
      () =>
        store.createProjectAsset({
          assetKey: 'memory/brief',
          kind: 'memory',
          memoryLayer: 'l1',
          title: 'stale',
          contentText: 'stale',
          expectedRevision: 9,
        }),
      (error) => error instanceof TaskConflictError,
    );

    const assetEvents = store
      .listEventLog()
      .filter((event) => event.kind === 'project-asset.created')
      .map((event) => JSON.parse(event.payload_json));

    assert.equal(assetEvents.length, 2);
    assert.deepEqual(
      Object.keys(assetEvents[0]).sort(),
      ['assetId', 'assetKey', 'contentHash', 'revision'],
    );
    assert.equal(JSON.stringify(assetEvents).includes('Remember the alpha constraints'), false);
    assert.equal(JSON.stringify(assetEvents).includes('source'), false);
    assert.equal(store.verifyEventLog().ok, true);
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('project asset keyPrefix matches literal prefixes rather than LIKE wildcards', () => {
  const harness = createStoreHarness('project-asset-prefix');
  const store = harness.open();

  try {
    const percentAsset = store.createProjectAsset({
      assetKey: 'memory/100%/brief',
      kind: 'memory',
      memoryLayer: 'l1',
      title: 'Percent prefix',
      contentText: 'Literal percent in key.',
      expectedRevision: 0,
    }).asset;
    const underscoreAsset = store.createProjectAsset({
      assetKey: 'memory/a_/brief',
      kind: 'memory',
      memoryLayer: 'l1',
      title: 'Underscore prefix',
      contentText: 'Literal underscore in key.',
      expectedRevision: 0,
    }).asset;
    const backslashAsset = store.createProjectAsset({
      assetKey: 'memory/back\\slash/brief',
      kind: 'memory',
      memoryLayer: 'l1',
      title: 'Backslash prefix',
      contentText: 'Literal backslash in key.',
      expectedRevision: 0,
    }).asset;
    store.createProjectAsset({
      assetKey: 'memory/1000/brief',
      kind: 'memory',
      memoryLayer: 'l1',
      title: 'Wildcard false positive',
      contentText: 'Should not match literal percent prefix.',
      expectedRevision: 0,
    });
    store.createProjectAsset({
      assetKey: 'memory/ab/brief',
      kind: 'memory',
      memoryLayer: 'l1',
      title: 'Wildcard false positive',
      contentText: 'Should not match literal underscore prefix.',
      expectedRevision: 0,
    });
    store.createProjectAsset({
      assetKey: 'memory/backslash/brief',
      kind: 'memory',
      memoryLayer: 'l1',
      title: 'Wildcard false positive',
      contentText: 'Should not match literal backslash prefix.',
      expectedRevision: 0,
    });

    assert.deepEqual(
      store.listProjectAssets({ keyPrefix: 'memory/100%' }).map((asset) => asset.assetId),
      [percentAsset.assetId],
    );
    assert.deepEqual(
      store.listProjectAssets({ keyPrefix: 'memory/a_' }).map((asset) => asset.assetId),
      [underscoreAsset.assetId],
    );
    assert.deepEqual(
      store.listProjectAssets({ keyPrefix: 'memory/back\\' }).map((asset) => asset.assetId),
      [backslashAsset.assetId],
    );
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('role loadouts validate assets, normalize entries, bind with CAS, and resolve immutable references', () => {
  const harness = createStoreHarness('role-loadouts');
  const store = harness.open();

  try {
    const memory = store.createProjectAsset({
      assetKey: 'memory/ops',
      kind: 'memory',
      memoryLayer: 'l2',
      title: 'Ops memory',
      contentText: 'Prefer narrow diffs.',
      expectedRevision: 0,
    }).asset;
    const skill = store.createProjectAsset({
      assetKey: 'skill/reviewer',
      kind: 'skill',
      title: 'Reviewer skill',
      contentText: 'Call out risks first.',
      source: { handbook: 'review-playbook' },
      expectedRevision: 0,
    }).asset;

    const created = store.createRoleLoadout({
      loadoutKey: 'executor/default',
      role: 'executor',
      entries: [
        { assetId: skill.assetId, injectionMode: 'reference', priority: 3 },
        { assetId: memory.assetId, injectionMode: 'direct', priority: 9 },
      ],
      expectedRevision: 0,
    });
    const replay = store.createRoleLoadout({
      loadoutKey: 'executor/default',
      role: 'executor',
      entries: [
        { assetId: memory.assetId, injectionMode: 'direct', priority: 9 },
        { assetId: skill.assetId, injectionMode: 'reference', priority: 3 },
      ],
      expectedRevision: 0,
    });
    const revisionTwo = store.createRoleLoadout({
      loadoutKey: 'executor/default',
      role: 'executor',
      entries: [{ assetId: memory.assetId, injectionMode: 'summary', priority: 5 }],
      byteBudget: 1_024,
      expectedRevision: 1,
    });

    assert.equal(created.status, 'created');
    assert.deepEqual(
      created.loadout.entries.map((entry) => entry.assetId),
      [memory.assetId, skill.assetId],
    );
    assert.equal(created.loadout.byteBudget, 8_192);
    assert.equal(replay.status, 'replayed');
    assert.equal(replay.loadout.loadoutId, created.loadout.loadoutId);
    assert.equal(store.getRoleLoadout({ loadoutKey: 'executor/default' }).revision, 2);
    assert.deepEqual(
      store.listRoleLoadouts({ role: 'executor' }).map((loadout) => loadout.revision),
      [2, 1],
    );

    assert.throws(
      () =>
        store.createRoleLoadout({
          loadoutKey: 'executor/missing',
          role: 'executor',
          entries: [{ assetId: 'missing-asset', injectionMode: 'tool', priority: 1 }],
          expectedRevision: 0,
        }),
      /Unknown project asset/,
    );
    assert.throws(
      () =>
        store.createRoleLoadout({
          loadoutKey: 'executor/default',
          role: 'executor',
          entries: [{ assetId: memory.assetId, injectionMode: 'summary', priority: 1 }],
          expectedRevision: 9,
        }),
      (error) => error instanceof TaskConflictError,
    );

    const firstBind = store.bindRoleLoadout({
      role: 'executor',
      loadoutId: created.loadout.loadoutId,
    });
    const bindReplay = store.bindRoleLoadout({
      role: 'executor',
      loadoutId: created.loadout.loadoutId,
      expectedCurrentLoadoutId: created.loadout.loadoutId,
    });

    assert.equal(firstBind.status, 'bound');
    assert.equal(bindReplay.status, 'replayed');
    assert.equal(store.getRoleLoadoutBinding('executor').loadoutId, created.loadout.loadoutId);

    assert.throws(
      () =>
        store.bindRoleLoadout({
          role: 'executor',
          loadoutId: revisionTwo.loadout.loadoutId,
          expectedCurrentLoadoutId: 'wrong-loadout',
        }),
      (error) => error instanceof TaskConflictError,
    );

    const rebound = store.bindRoleLoadout({
      role: 'executor',
      loadoutId: revisionTwo.loadout.loadoutId,
      expectedCurrentLoadoutId: created.loadout.loadoutId,
    });
    const resolved = store.resolveRoleLoadout('executor');

    assert.equal(rebound.status, 'bound');
    assert.deepEqual(store.listRoleLoadoutBindings(), [
      {
        role: 'executor',
        loadoutId: revisionTwo.loadout.loadoutId,
        boundAt: rebound.binding.boundAt,
      },
    ]);
    assert.equal(resolved.loadoutId, revisionTwo.loadout.loadoutId);
    assert.equal(Object.isFrozen(resolved), true);
    assert.equal(Object.isFrozen(resolved.assets), true);
    assert.equal(Object.isFrozen(resolved.assets[0]), true);
    assert.equal(resolved.assets.length, 1);
    assert.equal(resolved.assets[0].assetId, memory.assetId);
    assert.throws(() => {
      resolved.assets[0].title = 'mutated';
    }, TypeError);

    const loadoutEvents = store
      .listEventLog()
      .filter((event) => event.kind.startsWith('role-loadout.'))
      .map((event) => JSON.parse(event.payload_json));

    assert.deepEqual(
      Object.keys(loadoutEvents[0]).sort(),
      ['contentHash', 'loadoutId', 'loadoutKey', 'revision', 'role'],
    );
    assert.deepEqual(
      Object.keys(loadoutEvents.at(-1)).sort(),
      ['contentHash', 'loadoutId', 'loadoutRevision', 'role'],
    );
    assert.equal(JSON.stringify(loadoutEvents).includes('entries'), false);
    assert.equal(store.verifyEventLog().ok, true);
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('resolveRoleLoadout wraps binding, loadout, and asset reads in one deferred transaction', () => {
  const harness = createStoreHarness('role-loadout-deferred');
  const store = harness.open();

  try {
    const asset = store.createProjectAsset({
      assetKey: 'memory/ops',
      kind: 'memory',
      memoryLayer: 'l1',
      title: 'Ops memory',
      contentText: 'Prefer one snapshot.',
      expectedRevision: 0,
    }).asset;
    const loadout = store.createRoleLoadout({
      loadoutKey: 'executor/default',
      role: 'executor',
      entries: [{ assetId: asset.assetId, injectionMode: 'direct', priority: 1 }],
      expectedRevision: 0,
    }).loadout;
    store.bindRoleLoadout({
      role: 'executor',
      loadoutId: loadout.loadoutId,
    });

    const originalExec = DatabaseSync.prototype.exec;
    const seenSql = [];
    DatabaseSync.prototype.exec = function patchedExec(sql) {
      seenSql.push(sql);
      return originalExec.call(this, sql);
    };

    try {
      const resolved = store.resolveRoleLoadout('executor');
      assert.equal(resolved.loadoutId, loadout.loadoutId);
      assert.equal(resolved.assets[0].assetId, asset.assetId);
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }

    assert.deepEqual(seenSql, ['BEGIN DEFERRED', 'COMMIT']);
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('event log verification detects payload tampering', () => {
  const harness = createStoreHarness('tamper-payload');
  let store = harness.open();

  try {
    store.createTask({
      key: 'audit',
      payload: { level: 'full' },
    });
    const claim = store.claimTask({ worker: 'worker-audit' });
    store.completeTask({
      taskId: claim.taskId,
      worker: 'worker-audit',
      generation: claim.generation,
      claimToken: claim.claimToken,
      result: { done: true },
    });

    assert.equal(store.verifyEventLog().ok, true);
    store.close();
    store = null;

    const raw = new DatabaseSync(harness.dbPath);
    raw.exec(
      "UPDATE event_log SET payload_json = '{\"tampered\":true}' WHERE seq = 2",
    );
    raw.close();

    store = harness.open();
    const payloadTamper = store.verifyEventLog();
    assert.equal(payloadTamper.ok, false);
    assert.match(payloadTamper.reason, /Signature mismatch|Hash mismatch/);
  } finally {
    store?.close();
    harness.cleanup();
  }
});

test('event log verification detects signed-head tampering', () => {
  const harness = createStoreHarness('tamper-head');
  let store = harness.open();

  try {
    store.createTask({
      key: 'audit',
      payload: { level: 'full' },
    });
    const claim = store.claimTask({ worker: 'worker-audit' });
    store.completeTask({
      taskId: claim.taskId,
      worker: 'worker-audit',
      generation: claim.generation,
      claimToken: claim.claimToken,
      result: { done: true },
    });

    assert.equal(store.verifyEventLog().ok, true);
    store.close();
    store = null;

    const raw = new DatabaseSync(harness.dbPath);
    raw.exec(
      "UPDATE meta SET value = 'forged-signature' WHERE key = 'event_head_signature'",
    );
    raw.close();

    store = harness.open();
    const headTamper = store.verifyEventLog();
    assert.equal(headTamper.ok, false);
    assert.equal(headTamper.reason, 'Head metadata signature mismatch');
  } finally {
    store?.close();
    harness.cleanup();
  }
});
