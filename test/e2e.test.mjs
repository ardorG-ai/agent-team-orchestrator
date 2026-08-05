import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  return { repo, root, stateRoot: path.join(root, 'state') };
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

test('full team path fans out real worktrees and aggregates one exact candidate', async () => {
  const { repo, root, stateRoot } = createRepository();
  const baseOid = git(repo, 'rev-parse', 'HEAD');
  const context = projectContext(repo, { stateRoot });
  const store = openProjectStore({ dbPath: context.dbPath, secretKeyPath: context.keyPath });
  let childSequence = 0;

  const plan = {
    schema: 'team.plan.v1',
    summary: 'Create one committed file and verify the exact candidate through the fixed team DAG.',
    assumptions: ['The fixture repository uses Git and has one initial commit.'],
    acceptanceCriteria: [
      { id: 'ac-file', text: 'team-output.txt exists in the candidate commit.' },
      { id: 'ac-clean', text: 'The verification worktree is clean.' },
    ],
    lanes: {
      builder: {
        objective: 'Create team-output.txt, commit it, and leave the worktree clean.',
        scope: ['team-output.txt'],
      },
      researcher: {
        objective: 'Report the repository constraint relevant to the requested file.',
        scope: [],
      },
      test: {
        objective: 'Describe how the exact candidate should be checked.',
        scope: [],
      },
    },
    requiredChecks: ['git status --porcelain'],
  };

  const runAgent = async ({ cwd, prompt }) => {
    const role = /You are the ([a-z]+) for one fenced work unit\./u.exec(prompt)?.[1];
    if (role === 'planner') {
      return { finalMessage: JSON.stringify(plan), ok: true, terminal: { status: 'success' } };
    }
    if (role === 'builder') {
      writeFileSync(path.join(cwd, 'team-output.txt'), 'built by the team e2e fixture\n', 'utf8');
      git(cwd, 'add', 'team-output.txt');
      git(cwd, 'commit', '-m', 'Create the team e2e candidate');
      return { finalMessage: 'Created and committed team-output.txt.', ok: true, terminal: { status: 'success' } };
    }
    if (role === 'researcher') {
      return { finalMessage: 'The requested output is isolated to team-output.txt.', ok: true, terminal: { status: 'success' } };
    }
    if (role === 'test') {
      return { finalMessage: 'Verify the exact candidate file and a clean Git status.', ok: true, terminal: { status: 'success' } };
    }
    if (role === 'reviewer') {
      assert.match(readFileSync(path.join(cwd, 'team-output.txt'), 'utf8'), /team e2e fixture/u);
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
      const status = git(cwd, 'status', '--porcelain');
      assert.equal(status, '');
      assert.match(readFileSync(path.join(cwd, 'team-output.txt'), 'utf8'), /team e2e fixture/u);
      return {
        finalMessage: JSON.stringify({
          schema: 'team.verify.v1',
          verdict: 'PASS',
          summary: 'The exact candidate contains the requested file and the worktree is clean.',
          checks: [{
            name: 'git status --porcelain',
            status: 'PASS',
            evidence: 'Command returned no output.',
          }],
        }),
        ok: true,
        terminal: { status: 'success' },
      };
    }
    throw new Error(`Unexpected team role in prompt: ${role}`);
  };

  try {
    store.configureChannel({ channel: 'review', capacity: 8 });
    const parent = store.createTask({
      key: 'e2e-team',
      payload: {
        adapter: 'codex',
        baseOid,
        channel: 'review',
        description: 'Create and independently verify team-output.txt.',
        executionMode: 'planner',
        role: 'planner',
        scope: ['team-output.txt'],
        title: 'Exercise the complete Agent team',
      },
    }).task;

    const common = {
      adapters: { claude: runAgent, codex: runAgent },
      context,
      generateTaskId: () => `e2e-team-child-${++childSequence}`,
      leaseMs: 2_000,
      store,
      timeoutMs: 10_000,
    };

    const planned = await runWorkerOnce({
      ...common,
      taskId: parent.taskId,
      worker: 'planner-e2e',
    });
    assert.equal(planned.status, 'waiting-children', JSON.stringify(planned, null, 2));

    const children = store.listTaskChildren(parent.taskId);
    const childBySlice = Object.fromEntries(children.map((child) => [child.sliceKey, child]));
    for (const sliceKey of ['builder', 'researcher', 'test', 'reviewer', 'verifier']) {
      const result = await runWorkerOnce({
        ...common,
        taskId: childBySlice[sliceKey].taskId,
        worker: `${sliceKey}-e2e`,
      });
      assert.equal(result.status, 'completed', `${sliceKey}: ${JSON.stringify(result, null, 2)}`);
    }

    assert.equal(store.getTask(parent.taskId).state, 'queued');
    const aggregated = await runWorkerOnce({
      ...common,
      taskId: parent.taskId,
      worker: 'aggregate-e2e',
    });

    assert.equal(aggregated.status, 'completed', JSON.stringify(aggregated, null, 2));
    assert.equal(aggregated.task.result.verdict, 'READY_FOR_HUMAN');
    assert.notEqual(aggregated.task.result.candidateOid, baseOid);
    assert.equal(git(repo, 'rev-parse', 'main'), baseOid);
    assert.equal(existsSync(path.join(repo, 'team-output.txt')), false);
    assert.equal(store.listTaskChildren(parent.taskId).every((child) => child.state === 'completed'), true);
    assert.equal(store.getOutboxMessage(`candidate:${childBySlice.builder.taskId}:g1`), null);
    assert.equal(store.getOutboxMessage(`team:${parent.taskId}:g2`).payload.verdict, 'READY_FOR_HUMAN');
    assert.equal(store.verifyEventLog().ok, true);
  } finally {
    store.close();
    rmSync(root, { force: true, recursive: true });
  }
});
