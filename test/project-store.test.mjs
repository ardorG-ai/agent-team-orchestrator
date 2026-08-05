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
