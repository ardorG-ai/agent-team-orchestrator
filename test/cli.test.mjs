import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { executeCli } from '../src/cli.mjs';

function createRepository() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-team-cli-'));
  const repo = path.join(root, 'repo');
  const stateRoot = path.join(root, 'state');
  execFileSync('git', ['init', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'CLI Test']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'cli@example.com']);
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  execFileSync('git', ['-C', repo, 'add', 'README.md']);
  execFileSync('git', ['-C', repo, 'commit', '-m', 'fixture']);
  return { repo, stateRoot };
}

function projectArgs(repo, stateRoot) {
  return ['--repo', repo, '--state-root', stateRoot];
}

test('CLI initializes a project, creates an idempotent task, and verifies events', async () => {
  const { repo, stateRoot } = createRepository();
  const initialized = await executeCli(['init', ...projectArgs(repo, stateRoot)]);
  assert.equal(initialized.ok, true);
  assert.equal('keyPath' in initialized.context, false);
  assert.deepEqual(initialized.channels.map((entry) => entry.channel), ['builder', 'control', 'review']);

  const added = await executeCli([
    'task',
    'add',
    '--title',
    'Implement fixture',
    '--description',
    'Make one safe commit',
    '--adapter',
    'codex',
    '--scope',
    'src,test',
    '--idempotency-key',
    'fixture-task',
    ...projectArgs(repo, stateRoot),
  ]);
  const replay = await executeCli([
    'task',
    'add',
    '--title',
    'Implement fixture',
    '--description',
    'Make one safe commit',
    '--adapter',
    'codex',
    '--scope',
    'src,test',
    '--idempotency-key',
    'fixture-task',
    ...projectArgs(repo, stateRoot),
  ]);

  assert.equal(added.status, 'created');
  assert.equal(replay.status, 'replayed');
  assert.equal(replay.task.taskId, added.task.taskId);
  assert.match(added.task.payload.baseOid, /^[a-f0-9]{40}$/);

  const tasks = await executeCli(['task', 'list', ...projectArgs(repo, stateRoot)]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].payload.channel, 'review');

  const integrity = await executeCli(['events', 'verify', ...projectArgs(repo, stateRoot)]);
  assert.equal(integrity.ok, true);
  assert.equal(integrity.database, 'ok');
});

test('CLI exposes fenced manual task and outbox operations', async () => {
  const { repo, stateRoot } = createRepository();
  await executeCli(['init', ...projectArgs(repo, stateRoot)]);
  const added = await executeCli([
    'task', 'add',
    '--title', 'Review fence',
    '--idempotency-key', 'review-fence',
    ...projectArgs(repo, stateRoot),
  ]);
  const claim = await executeCli([
    'task', 'claim',
    '--worker', 'builder-1',
    '--task', added.task.taskId,
    '--lease-ms', '5000',
    ...projectArgs(repo, stateRoot),
  ]);
  assert.equal(claim.worker, 'builder-1');

  const heartbeat = await executeCli([
    'task', 'heartbeat', claim.taskId,
    '--worker', claim.worker,
    '--generation', String(claim.generation),
    '--claim-token', claim.claimToken,
    '--lease-ms', '5000',
    ...projectArgs(repo, stateRoot),
  ]);
  assert.equal(heartbeat.taskId, claim.taskId);

  const message = await executeCli([
    'outbox', 'enqueue',
    '--channel', 'review',
    '--idempotency-key', 'manual-review',
    '--payload', JSON.stringify({ taskId: claim.taskId }),
    '--task', claim.taskId,
    '--worker', claim.worker,
    '--generation', String(claim.generation),
    '--claim-token', claim.claimToken,
    ...projectArgs(repo, stateRoot),
  ]);
  const [leased] = await executeCli([
    'outbox', 'claim',
    '--channel', 'review',
    '--consumer', 'reviewer-1',
    ...projectArgs(repo, stateRoot),
  ]);
  assert.equal(leased.messageId, message.messageId);

  const acked = await executeCli([
    'outbox', 'ack', leased.messageId,
    '--consumer', leased.consumer,
    '--generation', String(leased.generation),
    '--lease-token', leased.leaseToken,
    ...projectArgs(repo, stateRoot),
  ]);
  assert.equal(acked, true);
});

test('worker run command delegates with the project store and runtime options', async () => {
  const { repo, stateRoot } = createRepository();
  await executeCli(['init', ...projectArgs(repo, stateRoot)]);
  let captured;
  const result = await executeCli([
    'worker', 'run',
    '--worker', 'builder-7',
    '--adapter', 'claude',
    '--lease-ms', '900',
    '--timeout-ms', '1200',
    ...projectArgs(repo, stateRoot),
  ], {
    runWorkerOnceFn: async (options) => {
      captured = options;
      return { status: 'idle' };
    },
  });

  assert.deepEqual(result, { status: 'idle' });
  assert.equal(captured.worker, 'builder-7');
  assert.equal(captured.adapter, 'claude');
  assert.equal(captured.leaseMs, 900);
  assert.equal(captured.timeoutMs, 1200);
  assert.equal(captured.context.repoRoot, realpathSync(repo));
});

test('gui command initializes channels and owns the server lifecycle', async () => {
  const { repo, stateRoot } = createRepository();
  let captured;
  let serverClosed = false;

  const result = await executeCli([
    'gui',
    '--host', '127.0.0.1',
    '--port', '4321',
    ...projectArgs(repo, stateRoot),
  ], {
    startGuiServerFn: async (options) => {
      captured = options;
      return {
        async close() {
          serverClosed = true;
        },
        host: options.host,
        port: options.port,
        url: `http://${options.host}:${options.port}`,
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.url, 'http://127.0.0.1:4321');
  assert.equal(captured.context.repoRoot, realpathSync(repo));
  assert.deepEqual(captured.store.listChannels().map((entry) => entry.channel), [
    'builder',
    'control',
    'review',
  ]);

  await result.close();
  assert.equal(serverClosed, true);
});

test('daemon command initializes channels, starts the scheduler, and owns the lifecycle', async () => {
  const { repo, stateRoot } = createRepository();
  let captured;
  let daemonClosed = false;

  const result = await executeCli([
    'daemon',
    '--host', '127.0.0.1',
    '--port', '4318',
    '--poll-ms', '250',
    '--lease-ms', '5000',
    '--timeout-ms', '9000',
    '--concurrency', '3',
    ...projectArgs(repo, stateRoot),
  ], {
    startDaemonFn: async (options) => {
      captured = options;
      return {
        async close() {
          daemonClosed = true;
        },
        host: options.host,
        port: options.port,
        status: {
          concurrency: options.concurrency,
          leaseMs: options.leaseMs,
          pollMs: options.pollMs,
          timeoutMs: options.timeoutMs,
        },
        url: `http://${options.host}:${options.port}`,
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.url, 'http://127.0.0.1:4318');
  assert.equal(result.concurrency, 3);
  assert.equal(result.pollMs, 250);
  assert.equal(result.leaseMs, 5000);
  assert.equal(result.timeoutMs, 9000);
  assert.equal(captured.timeoutMs, 9000);
  assert.equal(captured.context.repoRoot, realpathSync(repo));
  assert.deepEqual(captured.store.listChannels().map((entry) => entry.channel), [
    'builder',
    'control',
    'review',
  ]);

  await result.close();
  assert.equal(daemonClosed, true);
});

test('asset commands add, list, and show Project Brain assets including --content-file', async () => {
  const { repo, stateRoot } = createRepository();
  const assetFile = path.join(repo, 'brain-note.md');
  writeFileSync(assetFile, 'Reference memory from file.\n', 'utf8');

  await executeCli(['init', ...projectArgs(repo, stateRoot)]);

  const created = await executeCli([
    'asset', 'add',
    '--key', 'memory/alpha',
    '--kind', 'memory',
    '--title', 'Alpha memory',
    '--content-file', 'brain-note.md',
    '--layer', 'l2',
    '--source', JSON.stringify({ author: 'cli-test' }),
    ...projectArgs(repo, stateRoot),
  ], { cwd: repo });

  const second = await executeCli([
    'asset', 'add',
    '--key', 'skill/beta',
    '--kind', 'skill',
    '--title', 'Beta skill',
    '--content', 'Inline content',
    ...projectArgs(repo, stateRoot),
  ], { cwd: repo });

  assert.equal(created.status, 'created');
  assert.equal(created.asset.assetKey, 'memory/alpha');
  assert.equal(created.asset.memoryLayer, 'l2');
  assert.equal(created.asset.contentText, 'Reference memory from file.\n');
  assert.deepEqual(created.asset.source, { author: 'cli-test' });

  const listed = await executeCli([
    'asset', 'list',
    '--kind', 'memory',
    '--key-prefix', 'memory/',
    '--limit', '5',
    ...projectArgs(repo, stateRoot),
  ]);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].assetId, created.asset.assetId);

  const shown = await executeCli([
    'asset', 'show', created.asset.assetId,
    ...projectArgs(repo, stateRoot),
  ]);
  assert.deepEqual(shown, created.asset);

  const replay = await executeCli([
    'asset', 'add',
    '--key', 'skill/beta',
    '--kind', 'skill',
    '--title', 'Beta skill',
    '--content', 'Inline content',
    ...projectArgs(repo, stateRoot),
  ], { cwd: repo });
  assert.equal(second.status, 'created');
  assert.equal(replay.status, 'replayed');
  assert.equal(replay.asset.assetId, second.asset.assetId);
});

test('loadout commands create, bind, list, and show active role loadouts', async () => {
  const { repo, stateRoot } = createRepository();
  await executeCli(['init', ...projectArgs(repo, stateRoot)]);

  const memoryAsset = await executeCli([
    'asset', 'add',
    '--key', 'memory/reviewer-checklist',
    '--kind', 'memory',
    '--title', 'Reviewer checklist',
    '--content', 'Check the diff carefully.',
    '--layer', 'l1',
    ...projectArgs(repo, stateRoot),
  ]);
  const skillAsset = await executeCli([
    'asset', 'add',
    '--key', 'skill/reviewer-style',
    '--kind', 'skill',
    '--title', 'Reviewer style',
    '--content', 'Report findings first.',
    ...projectArgs(repo, stateRoot),
  ]);

  const created = await executeCli([
    'loadout', 'create',
    '--key', 'reviewer/default',
    '--role', 'reviewer',
    '--asset', `${memoryAsset.asset.assetId}:summary:50`,
    '--asset', `${skillAsset.asset.assetId}:tool`,
    '--byte-budget', '4096',
    ...projectArgs(repo, stateRoot),
  ]);

  assert.equal(created.status, 'created');
  assert.equal(created.loadout.loadoutKey, 'reviewer/default');
  assert.equal(created.loadout.role, 'reviewer');
  assert.equal(created.loadout.byteBudget, 4096);
  assert.deepEqual(created.loadout.entries, [
    {
      assetId: memoryAsset.asset.assetId,
      injectionMode: 'summary',
      priority: 50,
    },
    {
      assetId: skillAsset.asset.assetId,
      injectionMode: 'tool',
      priority: 1,
    },
  ]);

  const bound = await executeCli([
    'loadout', 'bind',
    '--role', 'reviewer',
    '--loadout', created.loadout.loadoutId,
    '--expect-unbound', 'true',
    ...projectArgs(repo, stateRoot),
  ]);
  assert.equal(bound.status, 'bound');
  assert.equal(bound.binding.loadoutId, created.loadout.loadoutId);

  const listed = await executeCli([
    'loadout', 'list',
    '--role', 'reviewer',
    '--limit', '5',
    ...projectArgs(repo, stateRoot),
  ]);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].loadoutId, created.loadout.loadoutId);

  const shown = await executeCli([
    'loadout', 'show',
    '--role', 'reviewer',
    ...projectArgs(repo, stateRoot),
  ]);
  assert.equal(shown.role, 'reviewer');
  assert.equal(shown.loadoutId, created.loadout.loadoutId);
  assert.deepEqual(shown.assets.map((asset) => ({
    assetId: asset.assetId,
    injectionMode: asset.injectionMode,
    priority: asset.priority,
  })), [
    {
      assetId: memoryAsset.asset.assetId,
      injectionMode: 'summary',
      priority: 50,
    },
    {
      assetId: skillAsset.asset.assetId,
      injectionMode: 'tool',
      priority: 1,
    },
  ]);
});

test('Project Brain CLI validation rejects invalid flag combinations and asset tokens', async () => {
  const { repo, stateRoot } = createRepository();
  await executeCli(['init', ...projectArgs(repo, stateRoot)]);

  await assert.rejects(
    executeCli([
      'asset', 'add',
      '--key', 'memory/bad',
      '--kind', 'memory',
      '--title', 'Bad asset',
      '--content', 'inline',
      '--content-file', 'ignored.txt',
      ...projectArgs(repo, stateRoot),
    ], { cwd: repo }),
    { code: 'invalid_argument', message: '--content and --content-file are mutually exclusive' },
  );

  await assert.rejects(
    executeCli([
      'asset', 'add',
      '--key', 'skill/bad-layer',
      '--kind', 'skill',
      '--title', 'Bad layer',
      '--content', 'inline',
      '--layer', 'l1',
      ...projectArgs(repo, stateRoot),
    ]),
    { code: 'invalid_argument', message: '--layer is only allowed when --kind=memory' },
  );

  await assert.rejects(
    executeCli([
      'loadout', 'create',
      '--key', 'reviewer/bad',
      '--role', 'reviewer',
      '--asset', 'asset-1:bogus',
      ...projectArgs(repo, stateRoot),
    ]),
    { code: 'invalid_argument', message: /unsupported mode "bogus"/ },
  );

  await assert.rejects(
    executeCli([
      'loadout', 'bind',
      '--role', 'reviewer',
      '--loadout', 'loadout-1',
      '--expected-current', 'loadout-0',
      '--expect-unbound', 'true',
      ...projectArgs(repo, stateRoot),
    ]),
    { code: 'invalid_argument', message: '--expected-current and --expect-unbound are mutually exclusive' },
  );
});

test('task add rejects scheduler flags that v0.1 does not enforce', async () => {
  const { repo, stateRoot } = createRepository();
  await executeCli(['init', ...projectArgs(repo, stateRoot)]);

  await assert.rejects(
    executeCli([
      'task', 'add',
      '--title', 'Unsupported retry budget',
      '--max-attempts', '2',
      '--idempotency-key', 'unsupported-budget',
      ...projectArgs(repo, stateRoot),
    ]),
    { code: 'unsupported_argument' },
  );
});

test('help does not advertise deferred scheduler flags', async () => {
  const help = await executeCli(['--help']);
  assert.doesNotMatch(help, /--priority|--max-attempts/);
  assert.match(help, /agent-team daemon/);
  assert.equal(await executeCli(['--version']), '0.2.0-dev.0');
});
