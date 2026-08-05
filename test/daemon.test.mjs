import test from 'node:test';
import assert from 'node:assert/strict';

import { startDaemon } from '../src/daemon.mjs';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

test('startDaemon starts GUI and worker loops, respects concurrency, and shuts down gracefully', async () => {
  const startedWorkers = [];
  const workerOptions = [];
  const running = [];
  const sleepCalls = [];
  let guiOptions;
  let guiClosed = false;
  let maxConcurrent = 0;

  const runWorkerOnce = async (options) => {
    startedWorkers.push(options.worker);
    workerOptions.push(options);
    const deferred = createDeferred();
    running.push(deferred);
    maxConcurrent = Math.max(maxConcurrent, running.length);
    const result = await deferred.promise;
    running.splice(running.indexOf(deferred), 1);
    return result;
  };

  const daemon = await startDaemon({
    concurrency: 2,
    context: { repoRoot: '/repo', worktreeRoot: '/repo/.worktrees' },
    host: '127.0.0.1',
    leaseMs: 2_000,
    pollMs: 250,
    port: 4317,
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    startGuiServer: async (options) => {
      guiOptions = options;
      return {
        async close() {
          guiClosed = true;
        },
        host: options.host,
        port: options.port,
        url: `http://${options.host}:${options.port}`,
      };
    },
    store: {},
    runWorkerOnce,
  });

  try {
    await waitFor(() => startedWorkers.length === 2);
    assert.equal(maxConcurrent, 2);
    assert.equal(daemon.url, 'http://127.0.0.1:4317');
    assert.equal(guiOptions.daemonStatus, daemon.status);
    assert.notEqual(guiOptions.runWorkerOnceFn, runWorkerOnce);
    assert.equal(guiOptions.workerTimeoutMs, 30 * 60_000);
    assert.equal(workerOptions.every((options) => options.timeoutMs === 30 * 60_000), true);
    assert.equal(workerOptions.every((options) => options.signal instanceof AbortSignal), true);
    assert.equal(workerOptions.every((options) => options.signal.aborted === false), true);
    assert.equal(workerOptions[0].activeClaimTokens, workerOptions[1].activeClaimTokens);

    const closePromise = daemon.close();
    await waitFor(() => guiClosed);
    running.splice(0).forEach((deferred) => deferred.resolve({ status: 'idle' }));
    await closePromise;

    assert.equal(guiClosed, true);
    assert.deepEqual(sleepCalls, []);
    assert.equal(startedWorkers.length, 2);
  } finally {
    await daemon.close();
  }
});

test('startDaemon aborts every active worker before waiting for shutdown', async () => {
  const observedSignals = [];
  let guiClosed = false;

  const daemon = await startDaemon({
    concurrency: 2,
    context: { repoRoot: '/repo', worktreeRoot: '/repo/.worktrees' },
    startGuiServer: async () => ({
      async close() {
        guiClosed = true;
      },
      host: '127.0.0.1',
      port: 4317,
      url: 'http://127.0.0.1:4317',
    }),
    store: {},
    runWorkerOnce: async ({ signal }) => {
      observedSignals.push(signal);
      await new Promise((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener('abort', resolve, { once: true });
      });
      return { status: 'interrupted' };
    },
  });

  await waitFor(() => observedSignals.length === 2);
  await daemon.close();

  assert.equal(guiClosed, true);
  assert.equal(observedSignals.every((signal) => signal.aborted), true);
  assert.equal(daemon.status.activeRuns, 0);
});

test('startDaemon drains an in-flight GUI run through the shared shutdown boundary', async () => {
  const calls = [];
  let guiRunPromise;
  let guiRunSettled = false;

  const daemon = await startDaemon({
    concurrency: 1,
    context: { repoRoot: '/repo', worktreeRoot: '/repo/.worktrees' },
    startGuiServer: async (options) => {
      guiRunPromise = options.runWorkerOnceFn({
        context: options.context,
        leaseMs: 30_000,
        store: options.store,
        taskId: 'manual-task',
        timeoutMs: options.workerTimeoutMs,
        worker: 'gui-manual',
      }).finally(() => {
        guiRunSettled = true;
      });
      return {
        async close() {
          await guiRunPromise;
        },
        host: '127.0.0.1',
        port: 4317,
        url: 'http://127.0.0.1:4317',
      };
    },
    store: {},
    runWorkerOnce: async (options) => {
      calls.push(options);
      await new Promise((resolve) => {
        if (options.signal.aborted) {
          resolve();
          return;
        }
        options.signal.addEventListener('abort', resolve, { once: true });
      });
      return { status: 'interrupted' };
    },
  });

  await waitFor(() => calls.length === 2);
  await daemon.close();

  assert.equal(guiRunSettled, true);
  assert.equal(calls.every(({ signal }) => signal.aborted), true);
  assert.equal(calls[0].activeClaimTokens, calls[1].activeClaimTokens);
});

test('startDaemon polls on idle, survives worker failures, and keeps scheduling', async () => {
  const sleepCalls = [];
  const calls = [];
  let guiClosed = false;

  const daemon = await startDaemon({
    concurrency: 1,
    context: { repoRoot: '/repo', worktreeRoot: '/repo/.worktrees' },
    now: (() => {
      let current = 10;
      return () => ++current;
    })(),
    pollMs: 75,
    sleep: async (ms) => {
      sleepCalls.push(ms);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    startGuiServer: async () => ({
      async close() {
        guiClosed = true;
      },
      host: '127.0.0.1',
      port: 4317,
      url: 'http://127.0.0.1:4317',
    }),
    store: {},
    runWorkerOnce: async (options) => {
      calls.push(options.worker);
      if (calls.length === 1) {
        throw new Error('boom');
      }
      if (calls.length === 2) {
        return { status: 'idle' };
      }
      if (calls.length === 3) {
        return { status: 'completed' };
      }
      return { status: 'idle' };
    },
  });

  try {
    await waitFor(() => calls.length >= 4);
    assert.deepEqual(sleepCalls.slice(0, 3), [75, 75, 75]);
    assert.equal(calls.every((worker) => worker === 'daemon-1'), true);
    assert.equal(daemon.status.errors.length >= 1, true);
    assert.match(daemon.status.errors[0].message, /boom/);
  } finally {
    await daemon.close();
    assert.equal(guiClosed, true);
  }
});

test('startDaemon closes promptly while a worker is sleeping between polls', async () => {
  const sleepCalls = [];
  const sleepDeferreds = [];
  let guiClosed = false;
  let workerCalls = 0;

  const daemon = await startDaemon({
    concurrency: 1,
    context: { repoRoot: '/repo', worktreeRoot: '/repo/.worktrees' },
    pollMs: 5_000,
    sleep: async (ms) => {
      sleepCalls.push(ms);
      const deferred = createDeferred();
      sleepDeferreds.push(deferred);
      return deferred.promise;
    },
    startGuiServer: async () => ({
      async close() {
        guiClosed = true;
      },
      host: '127.0.0.1',
      port: 4317,
      url: 'http://127.0.0.1:4317',
    }),
    store: {},
    runWorkerOnce: async () => {
      workerCalls += 1;
      return { status: 'idle' };
    },
  });

  try {
    await waitFor(() => sleepCalls.length === 1);
    assert.equal(workerCalls, 1);

    const closePromise = daemon.close();
    await closePromise;

    assert.equal(guiClosed, true);
    assert.equal(sleepCalls.length, 1);
    assert.equal(workerCalls, 1);
  } finally {
    sleepDeferreds.forEach((deferred) => deferred.resolve());
    await daemon.close();
  }
});
