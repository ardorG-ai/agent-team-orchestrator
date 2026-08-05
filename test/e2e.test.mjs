import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runWorkerOnce } from '../src/orchestrator.mjs';
import { projectContext } from '../src/project-context.mjs';
import { openProjectStore } from '../src/project-store.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/commit-agent.mjs', import.meta.url));

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    shell: false,
  }).trim();
}

function createRepository() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-team-e2e-'));
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo], { shell: false });
  git(repo, 'config', 'user.name', 'E2E Test');
  git(repo, 'config', 'user.email', 'e2e@example.com');
  writeFileSync(path.join(repo, 'README.md'), '# e2e fixture\n', 'utf8');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'Create the fixture repository');
  return { repo, stateRoot: path.join(root, 'state') };
}

test('full worker path produces a candidate without landing or deleting its worktree', async () => {
  const { repo, stateRoot } = createRepository();
  const baseOid = git(repo, 'rev-parse', 'HEAD');
  const context = projectContext(repo, { stateRoot });
  const store = openProjectStore({ dbPath: context.dbPath, secretKeyPath: context.keyPath });

  try {
    store.configureChannel({ channel: 'review', capacity: 4 });
    const created = store.createTask({
      key: 'e2e-candidate',
      payload: {
        adapter: 'codex',
        baseOid,
        channel: 'review',
        description: 'Create and commit agent-output.txt',
        scope: ['agent-output.txt'],
        title: 'Create a candidate commit',
      },
    }).task;

    const result = await runWorkerOnce({
      adapterOptions: {
        codex: {
          executable: process.execPath,
          launcherArgs: [fixturePath],
        },
      },
      context,
      leaseMs: 2_000,
      store,
      timeoutMs: 10_000,
      worker: 'builder-e2e',
    });

    assert.equal(result.status, 'completed', JSON.stringify(result, null, 2));
    assert.equal(result.run.finalMessage, 'fixture committed');
    assert.equal(result.claim.taskId, created.taskId);
    assert.equal(result.worktree.baseOid, baseOid);
    assert.notEqual(result.snapshot.candidateOid, baseOid);
    assert.equal(git(repo, 'rev-parse', 'main'), baseOid);
    assert.equal(existsSync(path.join(repo, 'agent-output.txt')), false);
    assert.equal(existsSync(result.worktree.worktreePath), true);
    assert.match(
      readFileSync(path.join(result.worktree.worktreePath, 'agent-output.txt'), 'utf8'),
      /committed by fake agent/,
    );
    assert.equal(git(result.worktree.worktreePath, 'status', '--porcelain'), '');

    const persisted = store.getTask(created.taskId);
    assert.equal(persisted.state, 'completed');
    assert.equal(persisted.result.candidateOid, result.snapshot.candidateOid);
    assert.equal(store.getOutboxMessage(`candidate:${created.taskId}:g1`).state, 'pending');
    assert.equal(store.verifyEventLog().ok, true);
  } finally {
    store.close();
  }
});
