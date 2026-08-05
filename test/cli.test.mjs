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
});
