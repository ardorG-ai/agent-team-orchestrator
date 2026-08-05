import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GUI_MUTATION_TOKEN_HEADER, startGuiServer } from '../src/gui-server.mjs';
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
        defaultTaskTtlMs: 50,
        defaultOutboxLeaseMs: 50,
      });
    },
    async makeWebRoot() {
      const webRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-web-`));
      await fs.writeFile(
        path.join(webRoot, 'index.html'),
        '<script src="/app.js"></script>',
      );
      await fs.writeFile(path.join(webRoot, 'styles.css'), 'body{color:black;}');
      await fs.writeFile(path.join(webRoot, 'app.js'), 'window.__agentTeamLoaded = true;');
      return webRoot;
    },
    cleanup(extraPaths = []) {
      for (const extraPath of extraPaths) {
        rmSync(extraPath, { force: true, recursive: true });
      }
      rmSync(root, { force: true, recursive: true });
    },
  };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  return {
    body: text.length === 0 ? null : JSON.parse(text),
    response,
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

test('startGuiServer binds loopback only', async () => {
  const harness = createStoreHarness('gui-loopback');
  const store = harness.open();

  try {
    await assert.rejects(
      startGuiServer({
        context: harness.context,
        host: '0.0.0.0',
        store,
        webRoot: await harness.makeWebRoot(),
      }),
      /loopback-only/,
    );
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('serves web assets without disclosing the mutation token and returns a capability launch URL', async () => {
  const harness = createStoreHarness('gui-static');
  const store = harness.open();
  const webRoot = await harness.makeWebRoot();
  const server = await startGuiServer({
    context: harness.context,
    mutationToken: 'token-123',
    store,
    webRoot,
  });

  try {
    const indexResponse = await fetch(`${server.url}/`);
    const html = await indexResponse.text();
    assert.equal(indexResponse.status, 200);
    assert.doesNotMatch(html, /token-123/);
    assert.equal(server.launchUrl, `${server.url}/#token=token-123`);
    assert.equal(indexResponse.headers.get('content-security-policy')?.includes("default-src 'none'"), true);
    assert.equal(indexResponse.headers.get('access-control-allow-origin'), null);

    const cssResponse = await fetch(`${server.url}/styles.css`);
    assert.equal(cssResponse.status, 200);
    assert.equal(await cssResponse.text(), 'body{color:black;}');
  } finally {
    await server.close();
    store.close();
    harness.cleanup([webRoot]);
  }
});

test('POST mutations require the mutation token and enforce the JSON body limit', async () => {
  const harness = createStoreHarness('gui-auth');
  const store = harness.open();
  const webRoot = await harness.makeWebRoot();
  const server = await startGuiServer({
    bodyLimitBytes: 64,
    context: harness.context,
    mutationToken: 'mutate-me',
    store,
    webRoot,
  });

  try {
    const missingToken = await fetchJson(`${server.url}/api/tasks`, {
      body: JSON.stringify({
        key: 'task-a',
        payload: { value: 1 },
      }),
      headers: {
        'content-type': 'application/json',
        origin: server.url,
      },
      method: 'POST',
    });
    assert.equal(missingToken.response.status, 403);
    assert.equal(missingToken.body.error.code, 'invalid_mutation_token');

    const wrongOrigin = await fetchJson(`${server.url}/api/tasks`, {
      body: JSON.stringify({
        key: 'task-origin',
        payload: { value: 1 },
      }),
      headers: {
        'content-type': 'application/json',
        [GUI_MUTATION_TOKEN_HEADER]: 'mutate-me',
        origin: 'http://attacker.invalid',
      },
      method: 'POST',
    });
    assert.equal(wrongOrigin.response.status, 403);
    assert.equal(wrongOrigin.body.error.code, 'invalid_origin');

    const largeBody = await fetchJson(`${server.url}/api/tasks`, {
      body: JSON.stringify({
        key: 'task-b',
        payload: { blob: 'x'.repeat(256) },
      }),
      headers: {
        'content-type': 'application/json',
        [GUI_MUTATION_TOKEN_HEADER]: 'mutate-me',
        origin: server.url,
      },
      method: 'POST',
    });
    assert.equal(largeBody.response.status, 413);
    assert.equal(largeBody.body.error.code, 'body_too_large');
  } finally {
    await server.close();
    store.close();
    harness.cleanup([webRoot]);
  }
});

test('snapshot endpoints sanitize lease tokens while exposing tasks, channels, outbox, events, verify, and runs', async () => {
  const harness = createStoreHarness('gui-snapshot');
  const store = harness.open();
  const webRoot = await harness.makeWebRoot();

  try {
    store.listProjectAssets = () => [{
      assetId: 'memory-root',
      claimToken: 'asset-secret',
      contentText: 'Pinned project memory summary with private full-body details.',
      contentHash: 'abc123def456',
      assetKey: 'memory/project-root',
      createdAt: 101,
      kind: 'memory',
      memoryLayer: 'l1',
      revision: 7,
      title: 'Project root memory',
      source: { secret: 'source-secret' },
    }];
    store.listRoleLoadoutBindings = () => [{
      boundAt: 102,
      claimToken: 'binding-secret',
      loadoutId: 'builder-default',
      role: 'builder',
    }];
    store.listRoleLoadouts = () => [{
      byteBudget: 4096,
      contentHash: 'deadbeef',
      createdAt: 103,
      entries: [{ assetId: 'memory-root', injectionMode: 'summary', priority: 5 }],
      loadoutId: 'builder-default',
      loadoutKey: 'builder/default',
      revision: 2,
      role: 'builder',
    }];
    store.configureChannel({ channel: 'review', capacity: 3 });
    const task = store.createTask({
      key: 'ship',
      payload: { channel: 'review', title: 'Ship feature' },
    }).task;
    const claim = store.claimTask({ taskId: task.taskId, worker: 'worker-snapshot' });
    store.appendTaskEvent({
      taskId: claim.taskId,
      worker: claim.worker,
      generation: claim.generation,
      claimToken: claim.claimToken,
      type: 'runtime',
      payload: { claimToken: 'nested-secret' },
    });
    store.enqueueOutbox({
      channel: 'review',
      messageId: 'candidate-1',
      payload: { taskId: task.taskId, status: 'ready' },
      taskId: claim.taskId,
      worker: claim.worker,
      generation: claim.generation,
      claimToken: claim.claimToken,
    });
    store.claimOutbox({
      channel: 'review',
      consumer: 'consumer-snapshot',
    });

    const server = await startGuiServer({
      context: harness.context,
      daemonStatus: {
        activeRuns: 1,
        concurrency: 2,
        errors: [new Error('hidden detail')],
        leaseMs: 30_000,
        pollMs: 1_000,
        running: true,
        startedAt: 123,
        timeoutMs: 1_800_000,
      },
      mutationToken: 'snapshot-token',
      store,
      webRoot,
    });

    try {
      const snapshot = await fetchJson(`${server.url}/api/snapshot`);
      assert.equal(snapshot.response.status, 200);
      assert.equal(snapshot.body.context.repoRoot, harness.context.repoRoot);
      assert.deepEqual(snapshot.body.daemon, {
        activeRuns: 1,
        concurrency: 2,
        errorCount: 1,
        leaseMs: 30_000,
        pollMs: 1_000,
        running: true,
        startedAt: 123,
        timeoutMs: 1_800_000,
      });
      assert.equal(snapshot.body.channels.length, 1);
      assert.equal(snapshot.body.tasks.length, 1);
      assert.equal(snapshot.body.outbox.length, 1);
      assert.equal(snapshot.body.projectAssets.length, 1);
      assert.equal(snapshot.body.projectAssets[0].contentText, undefined);
      assert.match(snapshot.body.projectAssets[0].preview, /Pinned project memory summary/);
      assert.equal(snapshot.body.roleLoadoutBindings.length, 1);
      assert.equal(snapshot.body.roleLoadouts.length, 1);
      assert.equal(snapshot.body.verify.eventLog.ok, true);
      assert.equal(snapshot.body.verify.integrityCheck, 'ok');
      assert.equal(JSON.stringify(snapshot.body).includes(claim.claimToken), false);
      assert.equal(JSON.stringify(snapshot.body).includes('nested-secret'), false);
      assert.equal(JSON.stringify(snapshot.body).includes('asset-secret'), false);
      assert.equal(JSON.stringify(snapshot.body).includes('binding-secret'), false);
      assert.equal(JSON.stringify(snapshot.body).includes('source-secret'), false);

      const tasks = await fetchJson(`${server.url}/api/tasks?state=running`);
      assert.equal(tasks.body.tasks[0].claimToken, undefined);

      const events = await fetchJson(`${server.url}/api/events?limit=10`);
      assert.equal(events.body.events.length >= 3, true);
      assert.equal(JSON.stringify(events.body).includes(claim.claimToken), false);
    } finally {
      await server.close();
    }
  } finally {
    store.close();
    harness.cleanup([webRoot]);
  }
});

test('project brain endpoints expose bounded read-only asset and role loadout projections', async () => {
  const harness = createStoreHarness('gui-brain-api');
  const store = harness.open();
  const webRoot = await harness.makeWebRoot();
  const observed = {
    assetCalls: [],
    loadoutCalls: [],
    resolveCalls: [],
  };

  try {
    store.listProjectAssets = (options = {}) => {
      observed.assetCalls.push(options);
      const assets = [
        {
          assetId: 'memory-a',
          assetKey: 'memory/a',
          claimToken: 'asset-secret',
          contentHash: 'hash-memory-a',
          contentText: 'private memory body',
          createdAt: 201,
          kind: 'memory',
          memoryLayer: 'l2',
          revision: 3,
          source: null,
          title: 'Memory A',
        },
        {
          assetId: 'skill-a',
          assetKey: 'skill/a',
          contentHash: 'hash-skill-a',
          contentText: 'private skill body',
          createdAt: 202,
          kind: 'skill',
          memoryLayer: null,
          revision: 1,
          source: { repo: 'handbook' },
          title: 'Skill A',
        },
      ];
      return assets
        .filter((asset) => !options.kind || asset.kind === options.kind)
        .slice(0, options.limit ?? assets.length);
    };
    store.listRoleLoadoutBindings = () => [
      { boundAt: 203, loadoutId: 'builder-default', role: 'builder' },
      { boundAt: 204, loadoutId: 'reviewer-default', role: 'reviewer' },
    ];
    store.listRoleLoadouts = (options = {}) => {
      observed.loadoutCalls.push(options);
      const loadouts = [
        {
          byteBudget: 8192,
          claimToken: 'loadout-secret',
          contentHash: 'hash-builder-loadout',
          createdAt: 205,
          entries: [{ assetId: 'memory-a', injectionMode: 'summary', priority: 5 }],
          loadoutId: 'builder-default',
          loadoutKey: 'builder/default',
          revision: 2,
          role: 'builder',
        },
        {
          byteBudget: 4096,
          contentHash: 'hash-reviewer-loadout',
          createdAt: 206,
          entries: [{ assetId: 'skill-a', injectionMode: 'reference', priority: 3 }],
          loadoutId: 'reviewer-default',
          loadoutKey: 'reviewer/default',
          revision: 1,
          role: 'reviewer',
        },
      ];
      return loadouts
        .filter((loadout) => !options.role || loadout.role === options.role)
        .slice(0, options.limit ?? loadouts.length);
    };
    store.resolveRoleLoadout = (role) => {
      observed.resolveCalls.push(role);
      return role ? {
        assets: [{
          assetId: 'memory-a',
          assetKey: 'memory/a',
          claimToken: 'resolved-secret',
          contentHash: 'hash-memory-a',
          contentText: 'resolved body',
          createdAt: 201,
          injectionMode: 'summary',
          kind: 'memory',
          memoryLayer: 'l2',
          priority: 5,
          revision: 3,
          source: null,
          title: 'Memory A',
        }],
        boundAt: 203,
        byteBudget: 8192,
        contentHash: 'hash-builder-loadout',
        loadoutId: `${role}-default`,
        loadoutKey: `${role}/default`,
        loadoutRevision: 2,
        role,
      } : null;
    };

    const server = await startGuiServer({
      context: harness.context,
      mutationToken: 'brain-token',
      store,
      webRoot,
    });

    try {
      const assets = await fetchJson(`${server.url}/api/project-assets?kind=memory&limit=1`);
      assert.equal(assets.response.status, 200);
      assert.deepEqual(observed.assetCalls.at(-1), { kind: 'memory', limit: 1 });
      assert.equal(assets.body.projectAssets.length, 1);
      assert.equal(assets.body.projectAssets[0].assetId, 'memory-a');
      assert.equal(assets.body.projectAssets[0].contentText, undefined);
      assert.equal(assets.body.projectAssets[0].preview, 'private memory body');
      assert.equal(JSON.stringify(assets.body).includes('asset-secret'), false);

      const loadouts = await fetchJson(`${server.url}/api/role-loadouts?role=builder&limit=1`);
      assert.equal(loadouts.response.status, 200);
      assert.deepEqual(observed.loadoutCalls.at(-1), { limit: 1, role: 'builder' });
      assert.equal(observed.resolveCalls.at(-1), 'builder');
      assert.equal(loadouts.body.roleLoadoutBindings.length, 2);
      assert.equal(loadouts.body.roleLoadouts.length, 1);
      assert.equal(loadouts.body.resolvedRoleLoadout.loadoutId, 'builder-default');
      assert.equal(JSON.stringify(loadouts.body).includes('loadout-secret'), false);
      assert.equal(JSON.stringify(loadouts.body).includes('resolved-secret'), false);

      const invalidLimit = await fetchJson(`${server.url}/api/project-assets?limit=999`);
      assert.equal(invalidLimit.response.status, 400);
      assert.equal(invalidLimit.body.error.code, 'invalid_integer');
    } finally {
      await server.close();
    }
  } finally {
    store.close();
    harness.cleanup([webRoot]);
  }
});

test('brain client consumes bounded asset preview rather than raw source or content fields', async () => {
  const appSource = await fs.readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const assetPreviewMatch = appSource.match(/function assetPreview\(asset\) \{([\s\S]*?)\n\}/);
  assert.ok(assetPreviewMatch, 'assetPreview() should exist');
  assert.match(assetPreviewMatch[1], /asset\?\.preview/);
  assert.doesNotMatch(assetPreviewMatch[1], /asset\?\.source/);
  assert.doesNotMatch(assetPreviewMatch[1], /asset\?\.contentText/);
});

test('background task runs are registered in-process and complete through the injected worker function', async () => {
  const harness = createStoreHarness('gui-runs');
  const store = harness.open();
  const webRoot = await harness.makeWebRoot();

  let resolveRun;
  let capturedRunOptions;
  const runWorkerOnceFn = (options) => new Promise((resolve) => {
    capturedRunOptions = options;
    resolveRun = resolve;
  });

  try {
    const task = store.createTask({
      key: 'run-me',
      payload: { title: 'Run me' },
    }).task;

    const server = await startGuiServer({
      context: harness.context,
      mutationToken: 'run-token',
      runWorkerOnceFn,
      store,
      webRoot,
    });

    try {
      const started = await fetchJson(`${server.url}/api/tasks/${task.taskId}/run`, {
        body: JSON.stringify({
          worker: 'worker-gui',
          leaseMs: 75,
        }),
        headers: {
          'content-type': 'application/json',
          [GUI_MUTATION_TOKEN_HEADER]: 'run-token',
          origin: server.url,
        },
        method: 'POST',
      });
      assert.equal(started.response.status, 202);
      assert.equal(started.body.run.status, 'running');
      assert.equal(started.body.run.taskId, task.taskId);
      assert.equal(capturedRunOptions.timeoutMs, 30 * 60_000);

      const running = await fetchJson(`${server.url}/api/runs`);
      assert.equal(running.body.runs.length, 1);
      assert.equal(running.body.runs[0].status, 'running');

      resolveRun({
        claim: {
          claimToken: 'secret-claim',
        },
        status: 'completed',
        task: {
          taskId: task.taskId,
        },
      });

      const completed = await waitFor(async () => {
        const response = await fetchJson(`${server.url}/api/runs`);
        return response.body.runs[0].status === 'completed' ? response.body.runs[0] : null;
      });
      assert.equal(completed.result.claim?.claimToken, undefined);
    } finally {
      await server.close();
    }
  } finally {
    store.close();
    harness.cleanup([webRoot]);
  }
});

test('GUI shutdown stops admitting runs and waits for an active manual run to settle', async () => {
  const harness = createStoreHarness('gui-drain');
  const store = harness.open();
  const webRoot = await harness.makeWebRoot();
  let resolveRun;
  let closed = false;

  try {
    const task = store.createTask({
      key: 'drain-me',
      payload: { title: 'Drain me' },
    }).task;
    const server = await startGuiServer({
      context: harness.context,
      mutationToken: 'drain-token',
      runWorkerOnceFn: () => new Promise((resolve) => {
        resolveRun = resolve;
      }),
      store,
      webRoot,
    });

    await fetchJson(`${server.url}/api/tasks/${task.taskId}/run`, {
      body: JSON.stringify({ worker: 'worker-drain' }),
      headers: {
        'content-type': 'application/json',
        [GUI_MUTATION_TOKEN_HEADER]: 'drain-token',
        origin: server.url,
      },
      method: 'POST',
    });

    const closePromise = server.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(closed, false);

    resolveRun({ status: 'completed' });
    await closePromise;
    assert.equal(closed, true);
  } finally {
    store.close();
    harness.cleanup([webRoot]);
  }
});

test('resident daemon mode rejects manual run launches outside its concurrency budget', async () => {
  const harness = createStoreHarness('gui-daemon-budget');
  const store = harness.open();
  const webRoot = await harness.makeWebRoot();
  let workerCalls = 0;

  try {
    const task = store.createTask({
      key: 'daemon-owned',
      payload: { title: 'Daemon owned' },
    }).task;
    const server = await startGuiServer({
      context: harness.context,
      daemonStatus: {
        activeRuns: 0,
        concurrency: 1,
        errors: [],
        leaseMs: 30_000,
        pollMs: 1_000,
        running: true,
        startedAt: 123,
      },
      mutationToken: 'daemon-token',
      runWorkerOnceFn: async () => {
        workerCalls += 1;
        return { status: 'completed' };
      },
      store,
      webRoot,
    });

    try {
      const response = await fetchJson(`${server.url}/api/tasks/${task.taskId}/run`, {
        body: JSON.stringify({ worker: 'manual-bypass' }),
        headers: {
          'content-type': 'application/json',
          [GUI_MUTATION_TOKEN_HEADER]: 'daemon-token',
          origin: server.url,
        },
        method: 'POST',
      });
      assert.equal(response.response.status, 409);
      assert.equal(response.body.error.code, 'daemon_managed_run');
      assert.equal(workerCalls, 0);
    } finally {
      await server.close();
    }
  } finally {
    store.close();
    harness.cleanup([webRoot]);
  }
});

test('manual run history retains only the configured number of completed entries', async () => {
  const harness = createStoreHarness('gui-run-retention');
  const store = harness.open();
  const webRoot = await harness.makeWebRoot();
  let clock = 100;

  try {
    const tasks = ['one', 'two', 'three'].map((key) => store.createTask({
      key,
      payload: { title: key },
    }).task);
    const server = await startGuiServer({
      context: harness.context,
      mutationToken: 'retention-token',
      now: () => ++clock,
      runHistoryLimit: 2,
      runWorkerOnceFn: async ({ taskId }) => ({ status: 'completed', taskId }),
      store,
      webRoot,
    });

    try {
      for (const task of tasks) {
        await fetchJson(`${server.url}/api/tasks/${task.taskId}/run`, {
          body: JSON.stringify({ worker: `worker-${task.key}` }),
          headers: {
            'content-type': 'application/json',
            [GUI_MUTATION_TOKEN_HEADER]: 'retention-token',
            origin: server.url,
          },
          method: 'POST',
        });
        await waitFor(async () => {
          const response = await fetchJson(`${server.url}/api/runs`);
          return response.body.runs.some((run) => (
            run.taskId === task.taskId && run.status === 'completed'
          ));
        });
      }

      const runs = await fetchJson(`${server.url}/api/runs`);
      assert.equal(runs.body.runs.length, 2);
      assert.deepEqual(
        runs.body.runs.map((run) => run.taskId),
        tasks.slice(1).map((task) => task.taskId),
      );
    } finally {
      await server.close();
    }
  } finally {
    store.close();
    harness.cleanup([webRoot]);
  }
});

test('unexpected server failures return a generic message', async () => {
  const harness = createStoreHarness('gui-generic-error');
  const store = harness.open();
  const webRoot = await harness.makeWebRoot();
  const server = await startGuiServer({
    context: harness.context,
    mutationToken: 'error-token',
    resolveCommitOidFn: async () => {
      throw new Error('sensitive /local/path detail');
    },
    store,
    webRoot,
  });

  try {
    const response = await fetchJson(`${server.url}/api/tasks`, {
      body: JSON.stringify({
        key: 'explode',
        payload: { title: 'Explode' },
      }),
      headers: {
        'content-type': 'application/json',
        [GUI_MUTATION_TOKEN_HEADER]: 'error-token',
        origin: server.url,
      },
      method: 'POST',
    });
    assert.equal(response.response.status, 500);
    assert.equal(response.body.error.message, 'The local GUI encountered an internal error');
    assert.equal(JSON.stringify(response.body).includes('/local/path'), false);
  } finally {
    await server.close();
    store.close();
    harness.cleanup([webRoot]);
  }
});

test('POST /api/tasks creates tasks and POST /api/tasks/:id/retry retries failed tasks', async () => {
  const harness = createStoreHarness('gui-posts');
  const store = harness.open();
  const webRoot = await harness.makeWebRoot();
  const server = await startGuiServer({
    context: harness.context,
    mutationToken: 'post-token',
    resolveCommitOidFn: async (repoRoot, ref) => {
      assert.equal(repoRoot, harness.context.repoRoot);
      assert.equal(ref, 'HEAD');
      return 'a'.repeat(40);
    },
    store,
    webRoot,
  });

  try {
    const created = await fetchJson(`${server.url}/api/tasks`, {
      body: JSON.stringify({
        key: 'created-via-api',
        payload: { title: 'From API' },
      }),
      headers: {
        'content-type': 'application/json',
        [GUI_MUTATION_TOKEN_HEADER]: 'post-token',
        origin: server.url,
      },
      method: 'POST',
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.status, 'created');
    assert.equal(created.body.task.payload.baseOid, 'a'.repeat(40));
    assert.equal(created.body.task.payload.baseRef, 'HEAD');

    const claim = store.claimTask({
      taskId: created.body.task.taskId,
      worker: 'worker-fail',
    });
    store.failTask({
      taskId: claim.taskId,
      worker: claim.worker,
      generation: claim.generation,
      claimToken: claim.claimToken,
      error: new Error('broken'),
    });

    const retried = await fetchJson(`${server.url}/api/tasks/${claim.taskId}/retry`, {
      body: JSON.stringify({
        expectedGeneration: claim.generation,
        reason: 'try again',
      }),
      headers: {
        'content-type': 'application/json',
        [GUI_MUTATION_TOKEN_HEADER]: 'post-token',
        origin: server.url,
      },
      method: 'POST',
    });
    assert.equal(retried.response.status, 200);
    assert.equal(retried.body.task.state, 'queued');
    assert.equal(retried.body.task.generation, claim.generation + 1);
  } finally {
    await server.close();
    store.close();
    harness.cleanup([webRoot]);
  }
});
