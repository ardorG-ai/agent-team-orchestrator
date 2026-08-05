import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runWorkerOnce } from '../src/orchestrator.mjs';
import { openProjectStore } from '../src/project-store.mjs';

function createStoreHarness(name) {
  const root = mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  const dbPath = path.join(root, 'project-store.sqlite');
  const secretKeyPath = path.join(root, 'secret.key');
  writeFileSync(secretKeyPath, `${name}-secret`);

  return {
    context: {
      repoRoot: root,
      worktreeRoot: path.join(root, 'worktrees'),
    },
    open() {
      return openProjectStore({
        dbPath,
        secretKeyPath,
        defaultTaskTtlMs: 250,
      });
    },
    cleanup() {
      rmSync(root, { force: true, recursive: true });
    },
  };
}

async function makeWorktreeRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-worktree-`));
}

test('runWorkerOnce completes a task and publishes a deterministic review candidate', async () => {
  const harness = createStoreHarness('orchestrator-success');
  const store = harness.open();
  const worktreePath = await makeWorktreeRoot('success');
  const promptCalls = [];
  const adapterCalls = [];

  try {
    store.configureChannel({ channel: 'review', capacity: 3 });
    const task = store.createTask({
      key: 'ship-feature',
      payload: {
        adapter: 'codex',
        baseOid: 'base-oid-preferred',
        base: 'feature-base',
        title: 'Ship feature',
      },
    }).task;

    const result = await runWorkerOnce({
      adapters: {
        codex: async (adapterOptions) => {
          adapterCalls.push(adapterOptions);
          return {
            finalMessage: 'done',
            nativeSessionId: 'sess-1',
            nativeThreadId: 'thread-1',
            ok: true,
            terminal: { status: 'success' },
          };
        },
      },
      buildPrompt: (claimedTask, claim, context) => {
        promptCalls.push({ claimedTask, claim, context });
        return `prompt for ${claimedTask.taskId} @ ${context.baseOid}`;
      },
      adapterOptions: {
        claude: { ignored: true },
        codex: {
          cwd: '/tmp/override-cwd',
          prompt: 'override prompt',
          scoped: 'codex-only',
          signal: 'override signal',
        },
        cwd: '/tmp/shared-cwd',
        extra: 'shared',
        prompt: 'shared prompt',
        signal: 'shared signal',
      },
      context: harness.context,
      createWorktree: async (options) => {
        assert.equal(options.repoPath, harness.context.repoRoot);
        assert.equal(options.ref, 'base-oid-preferred');
        assert.equal(options.task, task.taskId);
        assert.equal(options.generation, 1);
        assert.equal(options.worktreeRoot, harness.context.worktreeRoot);
        return {
          baseOid: 'a'.repeat(40),
          branchName: `${task.taskId}-g1`,
          worktreePath,
        };
      },
      leaseMs: 60,
      snapshotWorktree: async (options) => {
        assert.equal(options.worktreePath, worktreePath);
        return {
          candidateOid: 'b'.repeat(40),
          clean: true,
          worktreePath,
        };
      },
      store,
      worker: 'worker-a',
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.task.state, 'completed');
    assert.equal(result.outbox.messageId, `candidate:${task.taskId}:g1`);
    assert.equal(promptCalls.length, 1);
    assert.equal(promptCalls[0].context.repoRoot, worktreePath);
    assert.equal(promptCalls[0].context.baseOid, 'a'.repeat(40));
    assert.equal(adapterCalls.length, 1);
    assert.equal(adapterCalls[0].cwd, worktreePath);
    assert.equal(adapterCalls[0].extra, 'shared');
    assert.equal(adapterCalls[0].scoped, 'codex-only');
    assert.equal(adapterCalls[0].codex, undefined);
    assert.equal(adapterCalls[0].claude, undefined);
    assert.equal(adapterCalls[0].prompt, `prompt for ${task.taskId} @ ${'a'.repeat(40)}`);
    assert.ok(adapterCalls[0].signal instanceof AbortSignal);

    const completedTask = store.getTask(task.taskId);
    assert.equal(completedTask.state, 'completed');
    assert.deepEqual(completedTask.result, {
      adapter: 'codex',
      baseOid: 'a'.repeat(40),
      branchName: `${task.taskId}-g1`,
      candidateOid: 'b'.repeat(40),
      finalMessage: 'done',
      nativeSessionId: 'sess-1',
      nativeThreadId: 'thread-1',
      taskId: task.taskId,
      worktreePath,
    });

    const reviewMessage = store.getOutboxMessage(`candidate:${task.taskId}:g1`);
    assert.equal(reviewMessage.channel, 'review');
    assert.deepEqual(reviewMessage.payload, {
      adapter: 'codex',
      baseOid: 'a'.repeat(40),
      branchName: `${task.taskId}-g1`,
      candidateOid: 'b'.repeat(40),
      finalMessage: 'done',
      generation: 1,
      nativeSessionId: 'sess-1',
      nativeThreadId: 'thread-1',
      taskId: task.taskId,
      worker: 'worker-a',
      worktreePath,
    });

    const eventKinds = store.listEventLog().map((entry) => entry.kind);
    assert.ok(eventKinds.includes('task.event.preparation'));
    assert.ok(eventKinds.includes('task.event.runtime'));
  } finally {
    store.close();
    harness.cleanup();
    await fs.rm(worktreePath, { force: true, recursive: true });
  }
});

test('runWorkerOnce fences adapter failure into failTask without snapshotting', async () => {
  const harness = createStoreHarness('orchestrator-adapter-failure');
  const store = harness.open();
  const worktreePath = await makeWorktreeRoot('adapter-failure');
  let snapshotCalled = false;

  try {
    const task = store.createTask({
      key: 'broken-run',
      payload: {
        adapter: 'claude',
      },
    }).task;

    const result = await runWorkerOnce({
      adapters: {
        claude: async () => ({
          aborted: false,
          diagnostics: ['adapter exploded'],
          exitCode: 9,
          finalMessage: 'bad run',
          ok: false,
          terminal: {
            message: 'adapter exploded',
            status: 'failure',
          },
          timedOut: false,
        }),
      },
      buildPrompt: () => 'prompt',
      context: harness.context,
      createWorktree: async () => ({
        baseOid: 'c'.repeat(40),
        branchName: `${task.taskId}-g1`,
        worktreePath,
      }),
      snapshotWorktree: async () => {
        snapshotCalled = true;
        return { candidateOid: 'd'.repeat(40), clean: true, worktreePath };
      },
      store,
      worker: 'worker-b',
    });

    assert.equal(result.status, 'failed');
    assert.equal(snapshotCalled, false);
    const failedTask = store.getTask(task.taskId);
    assert.equal(failedTask.state, 'failed');
    assert.equal(failedTask.error.name, 'AdapterRunError');
    assert.equal(failedTask.error.adapter, 'claude');
    assert.equal(failedTask.error.message, 'adapter exploded');
    assert.equal(store.getOutboxMessage(`candidate:${task.taskId}:g1`), null);
  } finally {
    store.close();
    harness.cleanup();
    await fs.rm(worktreePath, { force: true, recursive: true });
  }
});

test('runWorkerOnce fences unsupported adapters after claim instead of leaving the task running', async () => {
  const harness = createStoreHarness('orchestrator-unsupported-adapter');
  const store = harness.open();

  try {
    const task = store.createTask({
      key: 'bad-adapter',
      payload: {
        adapter: 'unknown-adapter',
      },
    }).task;

    const result = await runWorkerOnce({
      context: harness.context,
      store,
      worker: 'worker-x',
    });

    assert.equal(result.status, 'failed');
    const failedTask = store.getTask(task.taskId);
    assert.equal(failedTask.state, 'failed');
    assert.match(failedTask.error.message, /unsupported adapter/i);
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('runWorkerOnce fails a task when the snapshot is dirty after a successful adapter run', async () => {
  const harness = createStoreHarness('orchestrator-dirty-snapshot');
  const store = harness.open();
  const worktreePath = await makeWorktreeRoot('dirty-snapshot');

  try {
    const task = store.createTask({
      key: 'dirty-worktree',
      payload: {
        adapter: 'codex',
      },
    }).task;

    const result = await runWorkerOnce({
      adapters: {
        codex: async () => ({
          finalMessage: 'finished',
          ok: true,
          terminal: { status: 'success' },
        }),
      },
      buildPrompt: () => 'prompt',
      context: harness.context,
      createWorktree: async () => ({
        baseOid: 'e'.repeat(40),
        branchName: `${task.taskId}-g1`,
        worktreePath,
      }),
      snapshotWorktree: async () => {
        throw new Error('snapshot requires a clean worktree');
      },
      store,
      worker: 'worker-c',
    });

    assert.equal(result.status, 'failed');
    const failedTask = store.getTask(task.taskId);
    assert.equal(failedTask.state, 'failed');
    assert.equal(failedTask.error.message, 'snapshot requires a clean worktree');
    assert.equal(store.getOutboxMessage(`candidate:${task.taskId}:g1`), null);
  } finally {
    store.close();
    harness.cleanup();
    await fs.rm(worktreePath, { force: true, recursive: true });
  }
});

test('runWorkerOnce requeues on review outbox backpressure without marking the task failed', async () => {
  const harness = createStoreHarness('orchestrator-backpressure');
  const store = harness.open();
  const worktreePath = await makeWorktreeRoot('backpressure');

  try {
    store.configureChannel({ channel: 'review', capacity: 1 });
    store.enqueueOutbox({
      channel: 'review',
      messageId: 'occupied-review-slot',
      payload: { occupied: true },
    });

    const task = store.createTask({
      key: 'backpressure-task',
      payload: {
        adapter: 'codex',
      },
    }).task;

    const result = await runWorkerOnce({
      adapters: {
        codex: async () => ({
          finalMessage: 'ready',
          ok: true,
          terminal: { status: 'success' },
        }),
      },
      buildPrompt: () => 'prompt',
      context: harness.context,
      createWorktree: async () => ({
        baseOid: '1'.repeat(40),
        branchName: `${task.taskId}-g1`,
        worktreePath,
      }),
      snapshotWorktree: async () => ({
        candidateOid: '2'.repeat(40),
        clean: true,
        worktreePath,
      }),
      store,
      worker: 'worker-pressure',
    });

    assert.equal(result.status, 'backpressure');
    assert.equal(result.task.state, 'queued');
    const queuedTask = store.getTask(task.taskId);
    assert.equal(queuedTask.state, 'queued');
    assert.equal(queuedTask.error, null);
    assert.equal(queuedTask.result, null);
    assert.equal(store.getOutboxMessage(`candidate:${task.taskId}:g1`), null);
  } finally {
    store.close();
    harness.cleanup();
    await fs.rm(worktreePath, { force: true, recursive: true });
  }
});

test('runWorkerOnce aborts the adapter on heartbeat lease loss and does not complete or fail the task', async () => {
  const worktreePath = await makeWorktreeRoot('lost-lease');
  let aborted = false;
  let failCalls = 0;
  let completeCalls = 0;
  let heartbeatCalls = 0;

  const task = {
    claimToken: 'claim-1',
    generation: 1,
    payload: {
      adapter: 'codex',
    },
    taskId: 'task-lost',
    worker: 'worker-d',
  };

  const store = {
    appendTaskEvent() {
      return true;
    },
    claimTask() {
      return task;
    },
    completeTask() {
      completeCalls += 1;
      return { outbox: {}, task: { state: 'completed' } };
    },
    failTask() {
      failCalls += 1;
      return { state: 'failed' };
    },
    heartbeatTask() {
      heartbeatCalls += 1;
      return null;
    },
    requeueExpiredTasks() {},
  };

  try {
    const result = await runWorkerOnce({
      adapters: {
        codex: ({ signal }) =>
          new Promise((resolve) => {
            const holdOpen = setTimeout(() => {
              resolve({
                aborted: false,
                finalMessage: 'unexpected timeout',
                ok: false,
                terminal: {
                  message: 'unexpected timeout',
                  status: 'failure',
                },
              });
            }, 1_000);
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(holdOpen);
                aborted = true;
                resolve({
                  aborted: true,
                  finalMessage: 'process aborted',
                  ok: false,
                  terminal: {
                    message: 'process aborted',
                    status: 'failure',
                  },
                });
              },
              { once: true },
            );
          }),
      },
      buildPrompt: () => 'prompt',
      context: {
        repoRoot: worktreePath,
        worktreeRoot: path.dirname(worktreePath),
      },
      createWorktree: async () => ({
        baseOid: 'f'.repeat(40),
        branchName: 'task-lost-g1',
        worktreePath,
      }),
      leaseMs: 30,
      snapshotWorktree: async () => ({
        candidateOid: '0'.repeat(40),
        clean: true,
        worktreePath,
      }),
      store,
      worker: 'worker-d',
    });

    assert.equal(result.status, 'lost-lease');
    assert.equal(aborted, true);
    assert.ok(heartbeatCalls >= 1);
    assert.equal(failCalls, 0);
    assert.equal(completeCalls, 0);
  } finally {
    await fs.rm(worktreePath, { force: true, recursive: true });
  }
});

test('runWorkerOnce treats heartbeat exceptions as lease loss and aborts without crashing', async () => {
  const worktreePath = await makeWorktreeRoot('heartbeat-error');
  let aborted = false;
  let failCalls = 0;
  let completeCalls = 0;

  const task = {
    claimToken: 'claim-heartbeat-error',
    generation: 1,
    payload: {
      adapter: 'codex',
    },
    taskId: 'task-heartbeat-error',
    worker: 'worker-e',
  };

  const store = {
    appendTaskEvent() {
      return true;
    },
    claimTask() {
      return task;
    },
    completeTask() {
      completeCalls += 1;
      return { outbox: {}, task: { state: 'completed' } };
    },
    failTask() {
      failCalls += 1;
      return { state: 'failed' };
    },
    heartbeatTask() {
      throw new Error('heartbeat exploded');
    },
    requeueExpiredTasks() {},
  };

  try {
    const result = await runWorkerOnce({
      adapters: {
        codex: ({ signal }) =>
          new Promise((resolve) => {
            const holdOpen = setTimeout(() => {
              resolve({
                aborted: false,
                finalMessage: 'unexpected timeout',
                ok: false,
                terminal: {
                  message: 'unexpected timeout',
                  status: 'failure',
                },
              });
            }, 1_000);
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(holdOpen);
                aborted = true;
                resolve({
                  aborted: true,
                  finalMessage: 'process aborted',
                  ok: false,
                  terminal: {
                    message: 'process aborted',
                    status: 'failure',
                  },
                });
              },
              { once: true },
            );
          }),
      },
      buildPrompt: () => 'prompt',
      context: {
        repoRoot: worktreePath,
        worktreeRoot: path.dirname(worktreePath),
      },
      createWorktree: async () => ({
        baseOid: '3'.repeat(40),
        branchName: 'task-heartbeat-error-g1',
        worktreePath,
      }),
      leaseMs: 30,
      snapshotWorktree: async () => ({
        candidateOid: '4'.repeat(40),
        clean: true,
        worktreePath,
      }),
      store,
      worker: 'worker-e',
    });

    assert.equal(result.status, 'lost-lease');
    assert.equal(aborted, true);
    assert.equal(failCalls, 0);
    assert.equal(completeCalls, 0);
  } finally {
    await fs.rm(worktreePath, { force: true, recursive: true });
  }
});
