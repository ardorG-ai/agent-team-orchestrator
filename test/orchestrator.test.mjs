import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runWorkerOnce as runWorkerOnceImpl } from '../src/orchestrator.mjs';
import { OutboxBackpressureError, openProjectStore } from '../src/project-store.mjs';

function runWorkerOnce(options) {
  return runWorkerOnceImpl({
    commitWorktreeCandidate: async ({ baseOid, scope, worktreePath }) => ({
      baseOid,
      changedPaths: scope.length > 0 ? [...scope] : ['fixture-change'],
      entryCount: scope.length > 0 ? scope.length : 1,
      headBefore: baseOid,
      parentOid: baseOid,
      scope: [...scope],
      worktreePath,
    }),
    ...options,
  });
}

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
  const candidateCalls = [];

  try {
    store.configureChannel({ channel: 'review', capacity: 3 });
    const task = store.createTask({
      key: 'ship-feature',
      payload: {
        adapter: 'codex',
        baseOid: 'base-oid-preferred',
        base: 'feature-base',
        scope: ['src/'],
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
      commitWorktreeCandidate: async (options) => {
        candidateCalls.push(options);
        return {
          baseOid: options.baseOid,
          candidateOid: 'b'.repeat(40),
          changedPaths: ['src/change.mjs'],
          clean: true,
          entryCount: 1,
          headBefore: options.baseOid,
          parentOid: options.baseOid,
          scope: ['src'],
          worktreePath,
        };
      },
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
    assert.equal(candidateCalls.length, 1);
    assert.equal(candidateCalls[0].baseOid, 'a'.repeat(40));
    assert.deepEqual(candidateCalls[0].scope, ['src/']);
    assert.equal(candidateCalls[0].worktreePath, worktreePath);
    assert.match(candidateCalls[0].commitMessage, /Preserve CLI isolation/);

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
    assert.ok(eventKinds.includes('task.event.candidate-finalized'));
    const candidateEvent = store.listEventLog()
      .find((entry) => entry.kind === 'task.event.candidate-finalized');
    const candidatePayload = JSON.parse(candidateEvent.payload_json).payload;
    assert.equal(candidatePayload.baseOid, 'a'.repeat(40));
    assert.equal(candidatePayload.candidateOid, 'b'.repeat(40));
    assert.equal(candidatePayload.controllerOwned, true);
    assert.deepEqual(candidatePayload.changedPathsPreview, ['src/change.mjs']);
  } finally {
    store.close();
    harness.cleanup();
    await fs.rm(worktreePath, { force: true, recursive: true });
  }
});

test('runWorkerOnce resolves the bound role loadout, injects bounded references, and audits exact hashes', async () => {
  const harness = createStoreHarness('orchestrator-loadout');
  const store = harness.open();
  const worktreePath = await makeWorktreeRoot('loadout');
  let deliveredPrompt = '';

  try {
    store.configureChannel({ channel: 'review', capacity: 3 });
    const memory = store.createProjectAsset({
      assetKey: 'memory/project-safety',
      kind: 'memory',
      memoryLayer: 'l3',
      title: 'Project safety doctrine',
      contentText: 'Never land an unverified candidate into main.',
      expectedRevision: 0,
    }).asset;
    const knowledge = store.createProjectAsset({
      assetKey: 'knowledge/codegraph',
      kind: 'knowledge',
      title: 'CodeGraph reference',
      contentText: 'This large knowledge body must stay outside the prompt.',
      source: {
        tool: 'codegraph',
        action: 'context',
        secret: 'source metadata must not enter the prompt',
      },
      expectedRevision: 0,
    }).asset;
    const loadout = store.createRoleLoadout({
      loadoutKey: 'builder/default',
      role: 'builder',
      byteBudget: 2_048,
      entries: [
        { assetId: memory.assetId, injectionMode: 'direct', priority: 10 },
        { assetId: knowledge.assetId, injectionMode: 'tool', priority: 1 },
      ],
      expectedRevision: 0,
    }).loadout;
    store.bindRoleLoadout({ role: 'builder', loadoutId: loadout.loadoutId });
    const task = store.createTask({
      key: 'loadout-task',
      payload: {
        adapter: 'codex',
        role: 'builder',
        title: 'Use project context safely',
      },
    }).task;

    const result = await runWorkerOnce({
      adapters: {
        codex: async ({ prompt }) => {
          deliveredPrompt = prompt;
          return {
            finalMessage: 'Never land an unverified candidate into main.',
            ok: true,
            terminal: {
              message: 'Never land an unverified candidate into main.',
              status: 'success',
            },
          };
        },
      },
      context: harness.context,
      createWorktree: async () => ({
        baseOid: '3'.repeat(40),
        branchName: `${task.taskId}-g1`,
        worktreePath,
      }),
      snapshotWorktree: async () => ({
        candidateOid: '4'.repeat(40),
        clean: true,
        worktreePath,
      }),
      store,
      worker: 'worker-loadout',
    });

    assert.equal(result.status, 'completed');
    assert.match(deliveredPrompt, /Controller-selected role reference/);
    assert.match(deliveredPrompt, /Never land an unverified candidate into main/);
    assert.doesNotMatch(deliveredPrompt, /This large knowledge body must stay outside the prompt/);
    assert.match(deliveredPrompt, /"tool":"codegraph"/);
    assert.doesNotMatch(deliveredPrompt, /source metadata must not enter the prompt/);

    const snapshotEvent = store.listEventLog()
      .find((event) => event.kind === 'task.event.loadout-snapshot');
    assert.ok(snapshotEvent);
    const eventPayload = JSON.parse(snapshotEvent.payload_json);
    const receipt = eventPayload.payload;
    assert.equal(eventPayload.taskId, task.taskId);
    assert.equal(eventPayload.type, 'loadout-snapshot');
    assert.equal(receipt.loadoutId, loadout.loadoutId);
    assert.equal(receipt.role, 'builder');
    assert.equal(receipt.bytes <= 2_048, true);
    assert.deepEqual(receipt.assets.map((asset) => asset.assetId), [memory.assetId, knowledge.assetId]);
    assert.equal(JSON.stringify(eventPayload).includes('Never land'), false);
    assert.equal(JSON.stringify(eventPayload).includes('codegraph'), false);

    const runtimeEvent = store.listEventLog()
      .find((event) => event.kind === 'task.event.runtime');
    assert.ok(runtimeEvent);
    const runtimePayload = JSON.parse(runtimeEvent.payload_json).payload;
    assert.deepEqual(runtimePayload, {
      aborted: false,
      adapter: 'codex',
      exitCode: null,
      nativeSessionId: null,
      nativeThreadId: null,
      ok: true,
      terminalStatus: 'success',
      timedOut: false,
    });
    assert.equal(JSON.stringify(runtimePayload).includes('Never land'), false);
    assert.equal(store.verifyEventLog().ok, true);
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
    assert.equal(
      store.listEventLog().some((event) => event.kind === 'task.event.candidate-finalized'),
      false,
    );
  } finally {
    store.close();
    harness.cleanup();
    await fs.rm(worktreePath, { force: true, recursive: true });
  }
});

test('runWorkerOnce aborts the adapter on heartbeat lease loss and does not complete or fail the task', async () => {
  const worktreePath = await makeWorktreeRoot('lost-lease');
  let aborted = false;
  let candidateCalls = 0;
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
      commitWorktreeCandidate: async () => {
        candidateCalls += 1;
        throw new Error('lost leases must never publish a candidate');
      },
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
    assert.equal(candidateCalls, 0);
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

test('runWorkerOnce excludes locally active claim tokens during expiry sweeps and releases its token on return', async () => {
  const worktreePath = await makeWorktreeRoot('exclude-active-claims');
  const seenExcludeLists = [];
  const activeClaimTokens = new Set(['already-running-claim']);
  const task = {
    claimToken: 'new-claim',
    generation: 3,
    payload: { adapter: 'codex' },
    taskId: 'task-exclude-claims',
    worker: 'worker-exclude',
  };

  const store = {
    appendTaskEvent() {
      return true;
    },
    claimTask() {
      return task;
    },
    completeTask() {
      return {
        outbox: {},
        task: { result: { ok: true }, state: 'completed' },
      };
    },
    heartbeatTask() {
      return task;
    },
    requeueExpiredTasks(input = {}) {
      seenExcludeLists.push(input.excludeClaimTokens ?? []);
    },
  };

  try {
    const result = await runWorkerOnce({
      activeClaimTokens,
      adapters: {
        codex: async () => ({
          finalMessage: 'done',
          ok: true,
          terminal: { status: 'success' },
        }),
      },
      buildPrompt: () => 'prompt',
      context: {
        repoRoot: worktreePath,
        worktreeRoot: path.dirname(worktreePath),
      },
      createWorktree: async () => ({
        baseOid: '1'.repeat(40),
        branchName: 'task-exclude-claims-g3',
        worktreePath,
      }),
      snapshotWorktree: async () => ({
        candidateOid: '2'.repeat(40),
        clean: true,
        worktreePath,
      }),
      store,
      worker: 'worker-exclude',
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(seenExcludeLists, [['already-running-claim']]);
    assert.deepEqual([...activeClaimTokens], ['already-running-claim']);
  } finally {
    await fs.rm(worktreePath, { force: true, recursive: true });
  }
});

test('runWorkerOnce requeues instead of failing when externally interrupted during adapter execution', async () => {
  const worktreePath = await makeWorktreeRoot('external-interrupt');
  const controller = new AbortController();
  let aborted = false;
  let failCalls = 0;
  let completeCalls = 0;
  let requeueCalls = 0;

  const task = {
    claimToken: 'claim-interrupt',
    generation: 1,
    payload: { adapter: 'codex' },
    taskId: 'task-interrupt',
    worker: 'worker-interrupt',
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
      return task;
    },
    requeueExpiredTasks() {},
    requeueTaskLease(input) {
      requeueCalls += 1;
      return { ...task, availableAt: input.availableAt ?? null, state: 'queued' };
    },
  };

  try {
    const resultPromise = runWorkerOnce({
      adapters: {
        codex: ({ signal }) =>
          new Promise((resolve) => {
            const handleAbort = () => {
              aborted = true;
              resolve({
                aborted: true,
                finalMessage: 'aborted by shutdown',
                ok: false,
                terminal: {
                  message: 'aborted by shutdown',
                  status: 'failure',
                },
              });
            };
            if (signal.aborted) {
              handleAbort();
              return;
            }
            signal.addEventListener('abort', handleAbort, { once: true });
          }),
      },
      buildPrompt: () => 'prompt',
      context: {
        repoRoot: worktreePath,
        worktreeRoot: path.dirname(worktreePath),
      },
      createWorktree: async () => ({
        baseOid: '5'.repeat(40),
        branchName: 'task-interrupt-g1',
        worktreePath,
      }),
      signal: controller.signal,
      snapshotWorktree: async () => ({
        candidateOid: '6'.repeat(40),
        clean: true,
        worktreePath,
      }),
      store,
      worker: 'worker-interrupt',
    });

    controller.abort();
    const result = await resultPromise;

    assert.equal(result.status, 'interrupted');
    assert.equal(result.task.state, 'queued');
    assert.equal(aborted, true);
    assert.equal(requeueCalls, 1);
    assert.equal(failCalls, 0);
    assert.equal(completeCalls, 0);
  } finally {
    await fs.rm(worktreePath, { force: true, recursive: true });
  }
});

test('runWorkerOnce reports lost-lease when an external interrupt cannot return the lease', async () => {
  const worktreePath = await makeWorktreeRoot('external-interrupt-lost-lease');
  const controller = new AbortController();
  let failCalls = 0;

  const task = {
    claimToken: 'claim-interrupt-lost',
    generation: 1,
    payload: { adapter: 'codex' },
    taskId: 'task-interrupt-lost',
    worker: 'worker-interrupt-lost',
  };

  const store = {
    appendTaskEvent() {
      return true;
    },
    claimTask() {
      return task;
    },
    completeTask() {
      return { outbox: {}, task: { state: 'completed' } };
    },
    failTask() {
      failCalls += 1;
      return { state: 'failed' };
    },
    heartbeatTask() {
      return task;
    },
    requeueExpiredTasks() {},
    requeueTaskLease() {
      return null;
    },
  };

  try {
    const resultPromise = runWorkerOnce({
      adapters: {
        codex: ({ signal }) =>
          new Promise((resolve) => {
            const handleAbort = () => {
              resolve({
                aborted: true,
                finalMessage: 'aborted after lease loss',
                ok: false,
                terminal: {
                  message: 'aborted after lease loss',
                  status: 'failure',
                },
              });
            };
            if (signal.aborted) {
              handleAbort();
              return;
            }
            signal.addEventListener('abort', handleAbort, { once: true });
          }),
      },
      buildPrompt: () => 'prompt',
      context: {
        repoRoot: worktreePath,
        worktreeRoot: path.dirname(worktreePath),
      },
      createWorktree: async () => ({
        baseOid: '7'.repeat(40),
        branchName: 'task-interrupt-lost-g1',
        worktreePath,
      }),
      signal: controller.signal,
      snapshotWorktree: async () => ({
        candidateOid: '8'.repeat(40),
        clean: true,
        worktreePath,
      }),
      store,
      worker: 'worker-interrupt-lost',
    });

    controller.abort();
    const result = await resultPromise;

    assert.equal(result.status, 'lost-lease');
    assert.equal(failCalls, 0);
  } finally {
    await fs.rm(worktreePath, { force: true, recursive: true });
  }
});

function validTeamPlan() {
  return {
    schema: 'team.plan.v1',
    summary: 'Implement and independently validate the requested behavior.',
    assumptions: ['Public APIs remain compatible.'],
    acceptanceCriteria: [{ id: 'ac-1', text: 'The requested behavior works.' }],
    lanes: {
      builder: { objective: 'Implement and leave scoped edits for controller publication.', scope: ['src/'] },
      researcher: { objective: 'Report relevant constraints.', scope: [] },
      test: { objective: 'Report required test coverage.', scope: ['test/'] },
    },
    requiredChecks: ['npm test'],
  };
}

function makeTeamClaim(overrides = {}) {
  return {
    claimToken: 'team-claim',
    generation: 1,
    key: 'team/root',
    parentTaskId: null,
    payload: {
      adapter: 'codex',
      executionMode: 'planner',
      role: 'planner',
      scope: ['src/', 'test/'],
      title: 'Ship a team change',
    },
    result: null,
    sliceKey: null,
    state: 'running',
    taskId: 'team-parent',
    worker: 'team-worker',
    ...overrides,
  };
}

function makeTeamStore({ claim, children = [], tasks = {} }) {
  const calls = {
    appendTaskEvent: [],
    completeTask: [],
    failTask: [],
    fanOutTask: [],
    requeueTaskLease: [],
  };
  return {
    calls,
    appendTaskEvent(input) {
      calls.appendTaskEvent.push(input);
      return true;
    },
    claimTask() {
      return claim;
    },
    completeTask(input) {
      calls.completeTask.push(input);
      const task = { ...claim, result: input.result, state: 'completed' };
      return input.outbox
        ? { task, outbox: { ...input.outbox, state: 'pending' } }
        : task;
    },
    failTask(input) {
      calls.failTask.push(input);
      return { ...claim, error: input.error, state: 'failed' };
    },
    fanOutTask(input) {
      calls.fanOutTask.push(input);
      return {
        parent: { ...claim, result: input.result, state: 'waiting_children' },
        children: input.children.map((child) => ({
          ...child,
          parentTaskId: claim.taskId,
          state: 'queued',
        })),
      };
    },
    getTask(taskId) {
      return tasks[taskId] ?? null;
    },
    heartbeatTask() {
      return claim;
    },
    listTaskChildren() {
      return children;
    },
    requeueExpiredTasks() {},
    requeueTaskLease(input) {
      calls.requeueTaskLease.push(input);
      return { ...claim, state: 'queued' };
    },
  };
}

function completedTeamChild(sliceKey, overrides = {}) {
  const adapter = sliceKey === 'researcher' || sliceKey === 'reviewer' ? 'claude' : 'codex';
  return {
    taskId: `team-${sliceKey}`,
    key: `team/root::${sliceKey}`,
    parentTaskId: 'team-parent',
    payload: { adapter, role: sliceKey },
    result: {
      adapter,
      baseOid: 'a'.repeat(40),
      candidateOid: sliceKey === 'builder' ? 'b'.repeat(40) : 'a'.repeat(40),
      finalMessage: `${sliceKey} complete`,
    },
    sliceKey,
    state: 'completed',
    ...overrides,
  };
}

function completedTeamChildren() {
  return [
    completedTeamChild('builder'),
    completedTeamChild('researcher'),
    completedTeamChild('test'),
    completedTeamChild('reviewer', {
      result: {
        adapter: 'claude',
        baseOid: 'b'.repeat(40),
        candidateOid: 'b'.repeat(40),
        finalMessage: 'approved',
        review: { schema: 'team.review.v1', verdict: 'APPROVED', findings: [] },
      },
    }),
    completedTeamChild('verifier', {
      result: {
        adapter: 'codex',
        baseOid: 'b'.repeat(40),
        candidateOid: 'b'.repeat(40),
        finalMessage: 'verified',
        verification: {
          schema: 'team.verify.v1',
          verdict: 'PASS',
          summary: 'All checks passed.',
          checks: [{ name: 'npm test', status: 'PASS', evidence: 'passed' }],
        },
      },
    }),
  ];
}

test('runWorkerOnce parses a planner result and atomically fans out the fixed team DAG', async () => {
  const worktreePath = await makeWorktreeRoot('team-planner');
  const claim = makeTeamClaim({
    payload: {
      adapter: 'codex',
      executionMode: 'planner',
      role: 'planner',
      scope: ['src/', 'test/'],
      teamAdapters: { builder: 'claude', reviewer: 'codex' },
      title: 'Ship a team change',
    },
  });
  const store = makeTeamStore({ claim });
  let generated = 0;

  try {
    const result = await runWorkerOnce({
      adapters: {
        codex: async () => ({
          finalMessage: JSON.stringify(validTeamPlan()),
          ok: true,
          terminal: { status: 'success' },
        }),
      },
      context: { repoRoot: worktreePath, worktreeRoot: path.dirname(worktreePath) },
      createWorktree: async ({ ref }) => {
        assert.equal(ref, 'HEAD');
        return {
          baseOid: 'a'.repeat(40),
          branchName: 'team-parent-g1',
          worktreePath,
        };
      },
      generateTaskId: () => `generated-${++generated}`,
      snapshotWorktree: async () => ({
        candidateOid: 'a'.repeat(40),
        clean: true,
        worktreePath,
      }),
      store,
      worker: claim.worker,
    });

    assert.equal(result.status, 'waiting-children');
    assert.equal(store.calls.completeTask.length, 0);
    assert.equal(store.calls.fanOutTask.length, 1);
    const fanOut = store.calls.fanOutTask[0];
    assert.equal(fanOut.result.plan.schema, 'team.plan.v1');
    assert.deepEqual(fanOut.children.map((child) => child.sliceKey), [
      'builder', 'researcher', 'test', 'reviewer', 'verifier',
    ]);
    assert.deepEqual(fanOut.children.map((child) => child.payload.adapter), [
      'claude', 'claude', 'codex', 'codex', 'codex',
    ]);
    assert.deepEqual(fanOut.children[3].dependencySliceKeys, ['builder', 'researcher', 'test']);
    assert.deepEqual(fanOut.children[4].dependencySliceKeys, ['reviewer']);
  } finally {
    await fs.rm(worktreePath, { force: true, recursive: true });
  }
});

test('runWorkerOnce resolves reviewer base from the builder candidate and injects bounded handoff', async () => {
  const worktreePath = await makeWorktreeRoot('team-reviewer');
  const builder = completedTeamChild('builder');
  const researcher = completedTeamChild('researcher');
  const testReport = completedTeamChild('test');
  const claim = makeTeamClaim({
    key: 'team/root::reviewer',
    parentTaskId: 'team-parent',
    payload: {
      adapter: 'claude',
      baseFromTaskId: builder.taskId,
      executionMode: 'review',
      handoffTaskIds: [builder.taskId, researcher.taskId, testReport.taskId],
      role: 'reviewer',
      scope: ['src/', 'test/'],
      title: 'Review candidate',
    },
    sliceKey: 'reviewer',
    taskId: 'team-reviewer',
  });
  const store = makeTeamStore({
    claim,
    tasks: Object.fromEntries([builder, researcher, testReport].map((task) => [task.taskId, task])),
  });
  let promptContext;

  try {
    const result = await runWorkerOnce({
      adapters: {
        claude: async () => ({
          finalMessage: JSON.stringify({
            schema: 'team.review.v1',
            verdict: 'APPROVED',
            findings: [],
          }),
          ok: true,
          terminal: { status: 'success' },
        }),
      },
      buildPrompt: (_task, _claim, context) => {
        promptContext = context;
        return 'review prompt';
      },
      context: { repoRoot: worktreePath, worktreeRoot: path.dirname(worktreePath) },
      createWorktree: async ({ ref }) => {
        assert.equal(ref, 'b'.repeat(40));
        return {
          baseOid: 'b'.repeat(40),
          branchName: 'team-reviewer-g1',
          worktreePath,
        };
      },
      snapshotWorktree: async () => ({
        candidateOid: 'b'.repeat(40),
        clean: true,
        worktreePath,
      }),
      store,
      worker: claim.worker,
    });

    assert.equal(result.status, 'completed');
    assert.match(promptContext.handoff, /UNTRUSTED HANDOFF DATA/);
    assert.match(promptContext.handoff, /team-builder/);
    assert.ok(Buffer.byteLength(promptContext.handoff, 'utf8') <= 12 * 1024);
    assert.equal(store.calls.completeTask.length, 1);
    assert.equal(store.calls.completeTask[0].outbox, undefined);
    assert.equal(store.calls.completeTask[0].result.review.verdict, 'APPROVED');
  } finally {
    await fs.rm(worktreePath, { force: true, recursive: true });
  }
});

test('runWorkerOnce fails closed before worktree creation when a dynamic base is not completed', async () => {
  const builder = {
    ...completedTeamChild('builder'),
    result: null,
    state: 'queued',
  };
  const claim = makeTeamClaim({
    key: 'team/root::reviewer',
    parentTaskId: 'team-parent',
    payload: {
      adapter: 'claude',
      baseFromTaskId: builder.taskId,
      executionMode: 'review',
      handoffTaskIds: [],
      role: 'reviewer',
      title: 'Review candidate',
    },
    sliceKey: 'reviewer',
    taskId: 'team-reviewer',
  });
  const store = makeTeamStore({ claim, tasks: { [builder.taskId]: builder } });
  let worktreeCreated = false;

  const result = await runWorkerOnce({
    context: { repoRoot: process.cwd(), worktreeRoot: os.tmpdir() },
    createWorktree: async () => {
      worktreeCreated = true;
      throw new Error('unexpected worktree');
    },
    store,
    worker: claim.worker,
  });

  assert.equal(result.status, 'failed');
  assert.equal(worktreeCreated, false);
  assert.match(store.calls.failTask[0].error.message, /must be completed/i);
});

test('runWorkerOnce rejects root-level dynamic base and handoff references before worktree creation', async () => {
  const foreign = completedTeamChild('builder');
  const cases = [
    {
      payload: {
        adapter: 'claude',
        baseFromTaskId: foreign.taskId,
        executionMode: 'review',
        handoffTaskIds: [],
        role: 'reviewer',
        title: 'Root review',
      },
      message: /baseFromTaskId requires a parent team task/i,
    },
    {
      payload: {
        adapter: 'claude',
        executionMode: 'report',
        handoffTaskIds: [foreign.taskId],
        role: 'researcher',
        title: 'Root report',
      },
      message: /handoffTaskIds requires a parent team task/i,
    },
  ];

  for (const [index, entry] of cases.entries()) {
    const claim = makeTeamClaim({
      key: `root-reference-${index}`,
      parentTaskId: null,
      payload: entry.payload,
      sliceKey: null,
      taskId: `root-reference-${index}`,
    });
    const store = makeTeamStore({ claim, tasks: { [foreign.taskId]: foreign } });
    let worktreeCreated = false;
    const result = await runWorkerOnce({
      context: { repoRoot: process.cwd(), worktreeRoot: os.tmpdir() },
      createWorktree: async () => {
        worktreeCreated = true;
        throw new Error('unexpected worktree');
      },
      store,
      worker: claim.worker,
    });

    assert.equal(result.status, 'failed');
    assert.equal(worktreeCreated, false);
    assert.match(store.calls.failTask[0].error.message, entry.message);
  }
});

test('runWorkerOnce constrains Claude researcher tools without blocking test checks', async () => {
  const cases = [
    { role: 'researcher', expectedTools: ['Read', 'Grep', 'Glob'] },
    { role: 'test', expectedTools: undefined },
  ];

  for (const entry of cases) {
    const worktreePath = await makeWorktreeRoot(`team-${entry.role}-tools`);
    const claim = makeTeamClaim({
      key: `team/root::${entry.role}-tools`,
      parentTaskId: 'team-parent',
      payload: {
        adapter: 'claude',
        executionMode: 'report',
        role: entry.role,
        title: `${entry.role} with bounded context`,
      },
      sliceKey: entry.role,
      taskId: `team-${entry.role}-tools`,
    });
    const store = makeTeamStore({ claim });
    let deliveredTools = null;

    try {
      const result = await runWorkerOnce({
        adapters: {
          claude: async (adapterOptions) => {
            deliveredTools = adapterOptions.tools;
            return {
              finalMessage: 'Bounded report.',
              ok: true,
              terminal: { status: 'success' },
            };
          },
        },
        buildPrompt: () => 'prompt',
        context: { repoRoot: worktreePath, worktreeRoot: path.dirname(worktreePath) },
        createWorktree: async () => ({
          baseOid: 'a'.repeat(40),
          branchName: `team-${entry.role}-tools-g1`,
          worktreePath,
        }),
        snapshotWorktree: async () => ({
          candidateOid: 'a'.repeat(40),
          clean: true,
          worktreePath,
        }),
        store,
        worker: claim.worker,
      });

      assert.equal(result.status, 'completed');
      assert.deepEqual(deliveredTools, entry.expectedTools);
    } finally {
      await fs.rm(worktreePath, { force: true, recursive: true });
    }
  }
});

test('runWorkerOnce fails closed when a read-only team role changes HEAD', async () => {
  const worktreePath = await makeWorktreeRoot('team-readonly-change');
  const claim = makeTeamClaim({
    key: 'team/root::researcher',
    parentTaskId: 'team-parent',
    payload: {
      adapter: 'claude',
      executionMode: 'report',
      role: 'researcher',
      title: 'Research only',
    },
    sliceKey: 'researcher',
    taskId: 'team-researcher',
  });
  const store = makeTeamStore({ claim });

  try {
    const result = await runWorkerOnce({
      adapters: {
        claude: async () => ({
          finalMessage: 'Research report.',
          ok: true,
          terminal: { status: 'success' },
        }),
      },
      buildPrompt: () => 'prompt',
      context: { repoRoot: worktreePath, worktreeRoot: path.dirname(worktreePath) },
      createWorktree: async () => ({
        baseOid: 'a'.repeat(40),
        branchName: 'team-researcher-g1',
        worktreePath,
      }),
      snapshotWorktree: async () => ({
        candidateOid: 'b'.repeat(40),
        clean: true,
        worktreePath,
      }),
      store,
      worker: claim.worker,
    });

    assert.equal(result.status, 'failed');
    assert.match(store.calls.failTask[0].error.message, /must not modify or commit/i);
  } finally {
    await fs.rm(worktreePath, { force: true, recursive: true });
  }
});

test('runWorkerOnce fails closed when a read-only team role leaves dirty files', async () => {
  const worktreePath = await makeWorktreeRoot('team-readonly-dirty');
  const claim = makeTeamClaim({
    key: 'team/root::researcher-dirty',
    parentTaskId: 'team-parent',
    payload: {
      adapter: 'claude',
      executionMode: 'report',
      role: 'researcher',
      title: 'Research without edits',
    },
    sliceKey: 'researcher',
    taskId: 'team-researcher-dirty',
  });
  const store = makeTeamStore({ claim });
  let candidateCalled = false;

  try {
    const result = await runWorkerOnce({
      adapters: {
        claude: async () => ({
          finalMessage: 'Research report with an accidental edit.',
          ok: true,
          terminal: { status: 'success' },
        }),
      },
      buildPrompt: () => 'prompt',
      commitWorktreeCandidate: async () => {
        candidateCalled = true;
        throw new Error('read-only roles must never reach candidate publication');
      },
      context: { repoRoot: worktreePath, worktreeRoot: path.dirname(worktreePath) },
      createWorktree: async () => ({
        baseOid: 'a'.repeat(40),
        branchName: 'team-researcher-dirty-g1',
        worktreePath,
      }),
      snapshotWorktree: async () => {
        throw new Error('snapshot requires a clean worktree');
      },
      store,
      worker: claim.worker,
    });

    assert.equal(result.status, 'failed');
    assert.equal(candidateCalled, false);
    assert.match(store.calls.failTask[0].error.message, /clean worktree/i);
  } finally {
    await fs.rm(worktreePath, { force: true, recursive: true });
  }
});

test('runWorkerOnce fails closed when a team builder produces no scoped mutation', async () => {
  const worktreePath = await makeWorktreeRoot('team-build-no-commit');
  const claim = makeTeamClaim({
    key: 'team/root::builder',
    parentTaskId: 'team-parent',
    payload: {
      adapter: 'codex',
      executionMode: 'build',
      role: 'builder',
      title: 'Build candidate',
    },
    sliceKey: 'builder',
    taskId: 'team-builder',
  });
  const store = makeTeamStore({ claim });

  try {
    const result = await runWorkerOnce({
      adapters: {
        codex: async () => ({
          finalMessage: 'No changes were needed.',
          ok: true,
          terminal: { status: 'success' },
        }),
      },
      buildPrompt: () => 'prompt',
      context: { repoRoot: worktreePath, worktreeRoot: path.dirname(worktreePath) },
      createWorktree: async () => ({
        baseOid: 'a'.repeat(40),
        branchName: 'team-builder-g1',
        worktreePath,
      }),
      snapshotWorktree: async () => ({
        candidateOid: 'a'.repeat(40),
        clean: true,
        worktreePath,
      }),
      store,
      worker: claim.worker,
    });

    assert.equal(result.status, 'failed');
    assert.match(store.calls.failTask[0].error.message, /new candidate commit/i);
  } finally {
    await fs.rm(worktreePath, { force: true, recursive: true });
  }
});

test('runWorkerOnce fails a review task whose verdict is not strict team.review.v1 JSON', async () => {
  const worktreePath = await makeWorktreeRoot('team-invalid-review');
  const builder = completedTeamChild('builder');
  const claim = makeTeamClaim({
    key: 'team/root::reviewer',
    parentTaskId: 'team-parent',
    payload: {
      adapter: 'claude',
      baseFromTaskId: builder.taskId,
      executionMode: 'review',
      handoffTaskIds: [builder.taskId],
      role: 'reviewer',
      title: 'Review candidate',
    },
    sliceKey: 'reviewer',
    taskId: 'team-reviewer',
  });
  const store = makeTeamStore({ claim, tasks: { [builder.taskId]: builder } });

  try {
    const result = await runWorkerOnce({
      adapters: {
        claude: async () => ({
          finalMessage: 'APPROVED',
          ok: true,
          terminal: { status: 'success' },
        }),
      },
      buildPrompt: () => 'prompt',
      context: { repoRoot: worktreePath, worktreeRoot: path.dirname(worktreePath) },
      createWorktree: async () => ({
        baseOid: 'b'.repeat(40),
        branchName: 'team-reviewer-g1',
        worktreePath,
      }),
      snapshotWorktree: async () => ({
        candidateOid: 'b'.repeat(40),
        clean: true,
        worktreePath,
      }),
      store,
      worker: claim.worker,
    });

    assert.equal(result.status, 'failed');
    assert.match(store.calls.failTask[0].error.message, /valid JSON/i);
  } finally {
    await fs.rm(worktreePath, { force: true, recursive: true });
  }
});

test('runWorkerOnce aggregates a resumed planner without launching a CLI or worktree', async () => {
  const claim = makeTeamClaim({
    generation: 2,
    result: { plan: validTeamPlan(), team: { phase: 'waiting-children' } },
  });
  const children = completedTeamChildren();
  const store = makeTeamStore({ claim, children });

  const result = await runWorkerOnce({
    adapters: {
      codex: async () => {
        throw new Error('aggregate must not launch an adapter');
      },
    },
    context: { repoRoot: process.cwd(), worktreeRoot: os.tmpdir() },
    createWorktree: async () => {
      throw new Error('aggregate must not create a worktree');
    },
    store,
    worker: claim.worker,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.task.result.verdict, 'READY_FOR_HUMAN');
  assert.equal(result.task.result.candidateOid, 'b'.repeat(40));
  assert.equal(store.calls.completeTask.length, 1);
  const completion = store.calls.completeTask[0];
  assert.equal(completion.outbox.messageId, 'team:team-parent:g2');
  assert.deepEqual(completion.outbox.payload.childTaskIds, children.map((child) => child.taskId));
  assert.equal(completion.outbox.payload.verdict, 'READY_FOR_HUMAN');
});

test('runWorkerOnce fails a resumed planner when any child failed', async () => {
  const claim = makeTeamClaim({
    generation: 2,
    result: { plan: validTeamPlan(), team: { phase: 'waiting-children' } },
  });
  const children = completedTeamChildren().map((child) => (
    child.sliceKey === 'test'
      ? { ...child, error: { message: 'test agent failed' }, result: null, state: 'failed' }
      : child
  ));
  const store = makeTeamStore({ claim, children });

  const result = await runWorkerOnce({
    context: { repoRoot: process.cwd(), worktreeRoot: os.tmpdir() },
    createWorktree: async () => {
      throw new Error('aggregate must not create a worktree');
    },
    store,
    worker: claim.worker,
  });

  assert.equal(result.status, 'failed');
  assert.equal(store.calls.completeTask.length, 0);
  assert.equal(store.calls.failTask.length, 1);
  assert.equal(store.calls.failTask[0].preserveResult, true);
  assert.match(store.calls.failTask[0].error.message, /test/i);
});

test('runWorkerOnce requeues a resumed planner when the final team review outbox is full', async () => {
  const claim = makeTeamClaim({
    generation: 2,
    result: { plan: validTeamPlan(), team: { phase: 'waiting-children' } },
  });
  const store = makeTeamStore({ claim, children: completedTeamChildren() });
  store.completeTask = (input) => {
    store.calls.completeTask.push(input);
    throw new OutboxBackpressureError('full', { channel: 'review' });
  };

  const result = await runWorkerOnce({
    context: { repoRoot: process.cwd(), worktreeRoot: os.tmpdir() },
    store,
    worker: claim.worker,
  });

  assert.equal(result.status, 'backpressure');
  assert.equal(store.calls.requeueTaskLease.length, 1);
  assert.equal(result.task.state, 'queued');
});

test('real store executes the fixed team lifecycle and wakes the planner for final aggregation', async () => {
  const harness = createStoreHarness('orchestrator-team-lifecycle');
  const store = harness.open();
  const runtimeRoot = await makeWorktreeRoot('team-lifecycle');
  const baseOid = 'a'.repeat(40);
  const candidateOid = 'b'.repeat(40);
  const roleByWorktree = new Map();
  let generated = 0;

  try {
    store.configureChannel({ channel: 'review', capacity: 3 });
    const parent = store.createTask({
      key: 'team-lifecycle',
      payload: {
        adapter: 'codex',
        executionMode: 'planner',
        role: 'planner',
        scope: ['src/', 'test/'],
        title: 'Exercise the complete team lifecycle',
      },
    }).task;

    const createWorktree = async ({ generation, ref, task }) => {
      const current = store.getTask(task);
      const role = current.payload.role;
      const expectedRef = role === 'planner' ? 'HEAD'
        : role === 'reviewer' || role === 'verifier' ? candidateOid
          : baseOid;
      assert.equal(ref, expectedRef);
      const worktreePath = path.join(runtimeRoot, `${task}-g${generation}`);
      roleByWorktree.set(worktreePath, role);
      return {
        baseOid: ref === 'HEAD' ? baseOid : ref,
        branchName: `${task}-g${generation}`,
        worktreePath,
      };
    };
    const runAdapter = async ({ cwd }) => {
      const role = roleByWorktree.get(cwd);
      const finalMessage = role === 'planner'
        ? JSON.stringify(validTeamPlan())
        : role === 'reviewer'
          ? JSON.stringify({
            schema: 'team.review.v1',
            verdict: 'APPROVED',
            findings: [],
          })
          : role === 'verifier'
            ? JSON.stringify({
              schema: 'team.verify.v1',
              verdict: 'PASS',
              summary: 'The exact candidate passed the required checks.',
              checks: [{ name: 'npm test', status: 'PASS', evidence: 'all tests passed' }],
            })
            : `${role} completed its bounded assignment.`;
      return { finalMessage, ok: true, terminal: { status: 'success' } };
    };
    const snapshotWorktree = async ({ worktreePath }) => {
      const role = roleByWorktree.get(worktreePath);
      return {
        candidateOid: role === 'builder' ? candidateOid
          : role === 'reviewer' || role === 'verifier' ? candidateOid
            : baseOid,
        clean: true,
        worktreePath,
      };
    };
    const commonOptions = {
      adapters: { claude: runAdapter, codex: runAdapter },
      context: harness.context,
      createWorktree,
      generateTaskId: () => `team-child-${++generated}`,
      snapshotWorktree,
      store,
    };

    const planned = await runWorkerOnce({
      ...commonOptions,
      taskId: parent.taskId,
      worker: 'planner-worker',
    });
    assert.equal(planned.status, 'waiting-children');
    assert.equal(store.getTask(parent.taskId).state, 'waiting_children');

    const childBySlice = Object.fromEntries(
      store.listTaskChildren(parent.taskId).map((child) => [child.sliceKey, child]),
    );
    for (const sliceKey of ['builder', 'researcher', 'test', 'reviewer', 'verifier']) {
      const execution = await runWorkerOnce({
        ...commonOptions,
        taskId: childBySlice[sliceKey].taskId,
        worker: `${sliceKey}-worker`,
      });
      assert.equal(execution.status, 'completed', `${sliceKey} should complete`);
    }

    assert.equal(store.getTask(parent.taskId).state, 'queued');
    const aggregated = await runWorkerOnce({
      ...commonOptions,
      createWorktree: async () => {
        throw new Error('resumed planner must not create another worktree');
      },
      taskId: parent.taskId,
      worker: 'aggregate-worker',
    });

    assert.equal(aggregated.status, 'completed');
    assert.equal(aggregated.task.result.verdict, 'READY_FOR_HUMAN');
    assert.equal(aggregated.task.result.candidateOid, candidateOid);
    assert.equal(store.listTaskChildren(parent.taskId).length, 5);
    const delivery = store.getOutboxMessage(`team:${parent.taskId}:g2`);
    assert.equal(delivery.payload.verdict, 'READY_FOR_HUMAN');
    assert.equal(delivery.payload.candidateOid, candidateOid);
    assert.equal(store.getOutboxMessage(`candidate:${childBySlice.builder.taskId}:g1`), null);
    assert.equal(store.verifyEventLog().ok, true);
  } finally {
    store.close();
    harness.cleanup();
    await fs.rm(runtimeRoot, { force: true, recursive: true });
  }
});

test('real store retries a failed team root by reusing successful children and re-aggregating without another fan-out', async () => {
  const harness = createStoreHarness('orchestrator-team-retry');
  const store = harness.open();
  const runtimeRoot = await makeWorktreeRoot('team-retry');
  const baseOid = 'a'.repeat(40);
  const candidateOid = 'b'.repeat(40);
  const roleByWorktree = new Map();
  let generated = 0;
  let builderAttempts = 0;

  try {
    store.configureChannel({ channel: 'review', capacity: 3 });
    const parent = store.createTask({
      key: 'team-retry-root',
      payload: {
        adapter: 'codex',
        executionMode: 'planner',
        role: 'planner',
        scope: ['src/', 'test/'],
        title: 'Recover a failed team root without a second fan-out',
      },
    }).task;

    const createWorktree = async ({ generation, ref, task }) => {
      const current = store.getTask(task);
      const role = current.payload.role;
      const expectedRef = role === 'planner' ? 'HEAD'
        : role === 'reviewer' || role === 'verifier' ? candidateOid
          : baseOid;
      assert.equal(ref, expectedRef);
      const worktreePath = path.join(runtimeRoot, `${task}-g${generation}`);
      roleByWorktree.set(worktreePath, role);
      return {
        baseOid: ref === 'HEAD' ? baseOid : ref,
        branchName: `${task}-g${generation}`,
        worktreePath,
      };
    };
    const runAdapter = async ({ cwd }) => {
      const role = roleByWorktree.get(cwd);
      if (role === 'planner') {
        return {
          finalMessage: JSON.stringify(validTeamPlan()),
          ok: true,
          terminal: { status: 'success' },
        };
      }
      if (role === 'builder') {
        builderAttempts += 1;
        if (builderAttempts === 1) {
          return {
            finalMessage: 'builder failed on first attempt',
            ok: false,
            terminal: { status: 'failure', message: 'builder failed on first attempt' },
          };
        }
        return {
          finalMessage: 'builder recovered and produced a candidate',
          ok: true,
          terminal: { status: 'success' },
        };
      }
      if (role === 'reviewer') {
        return {
          finalMessage: JSON.stringify({
            schema: 'team.review.v1',
            verdict: 'APPROVED',
            findings: [],
          }),
          ok: true,
          terminal: { status: 'success' },
        };
      }
      if (role === 'verifier') {
        return {
          finalMessage: JSON.stringify({
            schema: 'team.verify.v1',
            verdict: 'PASS',
            summary: 'Recovered candidate passed verification.',
            checks: [{ name: 'npm test', status: 'PASS', evidence: 'recovery path passed' }],
          }),
          ok: true,
          terminal: { status: 'success' },
        };
      }
      return {
        finalMessage: `${role} completed its bounded assignment.`,
        ok: true,
        terminal: { status: 'success' },
      };
    };
    const snapshotWorktree = async ({ worktreePath }) => {
      const role = roleByWorktree.get(worktreePath);
      return {
        candidateOid: role === 'builder' ? candidateOid
          : role === 'reviewer' || role === 'verifier' ? candidateOid
            : baseOid,
        clean: true,
        worktreePath,
      };
    };
    const commonOptions = {
      adapters: { claude: runAdapter, codex: runAdapter },
      context: harness.context,
      createWorktree,
      generateTaskId: () => `team-retry-child-${++generated}`,
      snapshotWorktree,
      store,
    };

    const planned = await runWorkerOnce({
      ...commonOptions,
      taskId: parent.taskId,
      worker: 'planner-worker',
    });
    assert.equal(planned.status, 'waiting-children');

    const initialChildren = store.listTaskChildren(parent.taskId);
    const initialChildIds = initialChildren.map((child) => child.taskId);
    const childBySlice = Object.fromEntries(initialChildren.map((child) => [child.sliceKey, child]));

    const firstBuilder = await runWorkerOnce({
      ...commonOptions,
      taskId: childBySlice.builder.taskId,
      worker: 'builder-worker',
    });
    assert.equal(firstBuilder.status, 'failed');

    const researcher = await runWorkerOnce({
      ...commonOptions,
      taskId: childBySlice.researcher.taskId,
      worker: 'researcher-worker',
    });
    assert.equal(researcher.status, 'completed');

    const tester = await runWorkerOnce({
      ...commonOptions,
      taskId: childBySlice.test.taskId,
      worker: 'test-worker',
    });
    assert.equal(tester.status, 'completed');

    assert.equal(store.getTask(childBySlice.reviewer.taskId).state, 'failed');
    assert.equal(store.getTask(childBySlice.verifier.taskId).state, 'failed');
    assert.equal(store.getTask(parent.taskId).state, 'queued');

    const failedAggregate = await runWorkerOnce({
      ...commonOptions,
      createWorktree: async () => {
        throw new Error('aggregate retry path must not recreate the planner worktree');
      },
      taskId: parent.taskId,
      worker: 'aggregate-worker',
    });
    assert.equal(failedAggregate.status, 'failed');

    const failedParent = store.getTask(parent.taskId);
    assert.equal(failedParent.state, 'failed');
    assert.deepEqual(failedParent.result.plan, validTeamPlan());

    const retriedParent = store.retryFailedTask({
      taskId: parent.taskId,
      expectedGeneration: failedParent.generation,
      reason: 'recover failed team root',
    });
    assert.equal(retriedParent.state, 'waiting_children');
    assert.deepEqual(retriedParent.result.plan, validTeamPlan());
    assert.deepEqual(
      store.listTaskChildren(parent.taskId).map((child) => child.taskId),
      initialChildIds,
    );
    assert.equal(store.getTask(childBySlice.researcher.taskId).state, 'completed');
    assert.equal(store.getTask(childBySlice.test.taskId).state, 'completed');
    assert.equal(store.getTask(childBySlice.builder.taskId).state, 'queued');
    assert.equal(store.getTask(childBySlice.reviewer.taskId).state, 'queued');
    assert.equal(store.getTask(childBySlice.verifier.taskId).state, 'queued');

    const rootWhileWaiting = await runWorkerOnce({
      ...commonOptions,
      taskId: parent.taskId,
      worker: 'aggregate-worker',
    });
    assert.equal(rootWhileWaiting.status, 'idle');

    const reviewerBeforeBuilder = await runWorkerOnce({
      ...commonOptions,
      taskId: childBySlice.reviewer.taskId,
      worker: 'reviewer-worker',
    });
    assert.equal(reviewerBeforeBuilder.status, 'idle');

    const recoveredBuilder = await runWorkerOnce({
      ...commonOptions,
      taskId: childBySlice.builder.taskId,
      worker: 'builder-worker',
    });
    assert.equal(recoveredBuilder.status, 'completed');

    const verifierBeforeReviewer = await runWorkerOnce({
      ...commonOptions,
      taskId: childBySlice.verifier.taskId,
      worker: 'verifier-worker',
    });
    assert.equal(verifierBeforeReviewer.status, 'idle');

    const recoveredReviewer = await runWorkerOnce({
      ...commonOptions,
      taskId: childBySlice.reviewer.taskId,
      worker: 'reviewer-worker',
    });
    assert.equal(recoveredReviewer.status, 'completed');

    const recoveredVerifier = await runWorkerOnce({
      ...commonOptions,
      taskId: childBySlice.verifier.taskId,
      worker: 'verifier-worker',
    });
    assert.equal(recoveredVerifier.status, 'completed');

    assert.equal(store.getTask(parent.taskId).state, 'queued');

    const recoveredAggregate = await runWorkerOnce({
      ...commonOptions,
      createWorktree: async () => {
        throw new Error('recovered aggregate must not rerun planner fan-out');
      },
      taskId: parent.taskId,
      worker: 'aggregate-worker',
    });
    assert.equal(recoveredAggregate.status, 'completed');
    assert.equal(recoveredAggregate.task.result.verdict, 'READY_FOR_HUMAN');
    assert.equal(recoveredAggregate.task.result.candidateOid, candidateOid);
    assert.equal(builderAttempts, 2);
    assert.deepEqual(
      store.listTaskChildren(parent.taskId).map((child) => child.taskId),
      initialChildIds,
    );
    assert.equal(store.listTaskChildren(parent.taskId).length, 5);
    assert.equal(store.getTask(childBySlice.researcher.taskId).generation, 1);
    assert.equal(store.getTask(childBySlice.test.taskId).generation, 1);
    assert.equal(store.getTask(childBySlice.builder.taskId).generation, 3);
    assert.equal(store.getTask(childBySlice.reviewer.taskId).generation, 2);
    assert.equal(store.getTask(childBySlice.verifier.taskId).generation, 2);

    const teamRetriedEvents = store
      .listEventLog()
      .filter((event) => event.kind === 'task.retried')
      .map((event) => JSON.parse(event.payload_json));
    assert.deepEqual(
      teamRetriedEvents.map((event) => [event.taskId, event.reason]).sort((a, b) => a[0].localeCompare(b[0])),
      [
        [parent.taskId, 'recover failed team root'],
        [childBySlice.builder.taskId, `parent/team retry:${parent.taskId}`],
        [childBySlice.reviewer.taskId, `parent/team retry:${parent.taskId}`],
        [childBySlice.verifier.taskId, `parent/team retry:${parent.taskId}`],
      ],
    );
    assert.equal(store.verifyEventLog().ok, true);
  } finally {
    store.close();
    harness.cleanup();
    await fs.rm(runtimeRoot, { force: true, recursive: true });
  }
});

test('real store retries a failed aggregate-only team root without touching completed children or relaunching a CLI', async () => {
  const harness = createStoreHarness('orchestrator-team-aggregate-retry');
  const store = harness.open();
  const runtimeRoot = await makeWorktreeRoot('team-aggregate-retry');
  const baseOid = 'a'.repeat(40);
  const candidateOid = 'b'.repeat(40);
  const roleByWorktree = new Map();
  let generated = 0;

  try {
    store.configureChannel({ channel: 'review', capacity: 3 });
    const parent = store.createTask({
      key: 'team-aggregate-retry-root',
      payload: {
        adapter: 'codex',
        executionMode: 'planner',
        role: 'planner',
        scope: ['src/', 'test/'],
        title: 'Retry only the final aggregate step.',
      },
    }).task;

    const createWorktree = async ({ generation, ref, task }) => {
      const current = store.getTask(task);
      const role = current.payload.role;
      const expectedRef = role === 'planner' ? 'HEAD'
        : role === 'reviewer' || role === 'verifier' ? candidateOid
          : baseOid;
      assert.equal(ref, expectedRef);
      const worktreePath = path.join(runtimeRoot, `${task}-g${generation}`);
      roleByWorktree.set(worktreePath, role);
      return {
        baseOid: ref === 'HEAD' ? baseOid : ref,
        branchName: `${task}-g${generation}`,
        worktreePath,
      };
    };
    const runAdapter = async ({ cwd }) => {
      const role = roleByWorktree.get(cwd);
      if (role === 'planner') {
        return {
          finalMessage: JSON.stringify(validTeamPlan()),
          ok: true,
          terminal: { status: 'success' },
        };
      }
      if (role === 'reviewer') {
        return {
          finalMessage: JSON.stringify({
            schema: 'team.review.v1',
            verdict: 'APPROVED',
            findings: [],
          }),
          ok: true,
          terminal: { status: 'success' },
        };
      }
      if (role === 'verifier') {
        return {
          finalMessage: JSON.stringify({
            schema: 'team.verify.v1',
            verdict: 'PASS',
            summary: 'Recovered aggregate-only retry passed verification.',
            checks: [{ name: 'npm test', status: 'PASS', evidence: 'aggregate-only retry passed' }],
          }),
          ok: true,
          terminal: { status: 'success' },
        };
      }
      return {
        finalMessage: `${role} completed its bounded assignment.`,
        ok: true,
        terminal: { status: 'success' },
      };
    };
    const snapshotWorktree = async ({ worktreePath }) => {
      const role = roleByWorktree.get(worktreePath);
      return {
        candidateOid: role === 'builder' ? candidateOid
          : role === 'reviewer' || role === 'verifier' ? candidateOid
            : baseOid,
        clean: true,
        worktreePath,
      };
    };
    const commonOptions = {
      adapters: { claude: runAdapter, codex: runAdapter },
      context: harness.context,
      createWorktree,
      generateTaskId: () => `team-aggregate-retry-child-${++generated}`,
      snapshotWorktree,
      store,
    };

    const planned = await runWorkerOnce({
      ...commonOptions,
      taskId: parent.taskId,
      worker: 'planner-worker',
    });
    assert.equal(planned.status, 'waiting-children');

    const children = store.listTaskChildren(parent.taskId);
    const childIds = children.map((child) => child.taskId);
    const childBySlice = Object.fromEntries(children.map((child) => [child.sliceKey, child]));

    for (const sliceKey of ['builder', 'researcher', 'test', 'reviewer', 'verifier']) {
      const execution = await runWorkerOnce({
        ...commonOptions,
        taskId: childBySlice[sliceKey].taskId,
        worker: `${sliceKey}-worker`,
      });
      assert.equal(execution.status, 'completed', `${sliceKey} should complete before retry`);
    }

    assert.equal(store.getTask(parent.taskId).state, 'queued');
    const childGenerationsBeforeRetry = Object.fromEntries(
      children.map((child) => [child.taskId, store.getTask(child.taskId).generation]),
    );

    const aggregateClaim = store.claimTask({ worker: 'aggregate-worker', taskId: parent.taskId });
    const failedParent = store.failTask({
      taskId: aggregateClaim.taskId,
      worker: aggregateClaim.worker,
      generation: aggregateClaim.generation,
      claimToken: aggregateClaim.claimToken,
      error: new Error('aggregate interrupted after all children completed'),
      preserveResult: true,
    });
    assert.deepEqual(failedParent.result.plan, validTeamPlan());

    const retriedParent = store.retryFailedTask({
      taskId: failedParent.taskId,
      expectedGeneration: failedParent.generation,
      reason: 'retry aggregate only',
    });
    assert.equal(retriedParent.state, 'queued');
    assert.deepEqual(retriedParent.result.plan, validTeamPlan());
    assert.deepEqual(
      Object.fromEntries(children.map((child) => [child.taskId, store.getTask(child.taskId).generation])),
      childGenerationsBeforeRetry,
    );

    const teamRecoveryEvents = store.listEventLog()
      .filter((event) => event.kind === 'task.team-recovery');
    assert.equal(teamRecoveryEvents.length, 0);

    const aggregated = await runWorkerOnce({
      ...commonOptions,
      adapters: {
        claude: async () => {
          throw new Error('aggregate-only retry must not relaunch an adapter');
        },
        codex: async () => {
          throw new Error('aggregate-only retry must not relaunch an adapter');
        },
      },
      createWorktree: async () => {
        throw new Error('aggregate-only retry must not recreate a worktree');
      },
      taskId: parent.taskId,
      worker: 'aggregate-worker',
    });
    assert.equal(aggregated.status, 'completed');
    assert.equal(aggregated.task.result.verdict, 'READY_FOR_HUMAN');
    assert.equal(aggregated.task.result.candidateOid, candidateOid);
    assert.deepEqual(store.listTaskChildren(parent.taskId).map((child) => child.taskId), childIds);

    const teamOutbox = store.listOutbox()
      .filter((message) => message.messageId.startsWith(`team:${parent.taskId}:`));
    assert.equal(teamOutbox.length, 1);
    assert.equal(teamOutbox[0].payload.verdict, 'READY_FOR_HUMAN');
    assert.equal(teamOutbox[0].payload.candidateOid, candidateOid);
    assert.equal(store.verifyEventLog().ok, true);
  } finally {
    store.close();
    harness.cleanup();
    await fs.rm(runtimeRoot, { force: true, recursive: true });
  }
});
