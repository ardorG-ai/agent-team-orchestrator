import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createWorktree, deriveBranchName, resolveCommitOid, snapshotWorktree } from '../src/worktree.mjs';

async function run(command, args, cwd) {
  const { runSubprocess } = await import('../src/subprocess.mjs');
  const result = await runSubprocess({
    command,
    args,
    cwd,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
    timeoutMs: 10_000,
  });

  if (!result.success) {
    throw new Error(result.stderr || result.stdout || `${command} failed`);
  }

  return result.stdout.trim();
}

async function initRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-worktree-'));
  await run('git', ['init', root], root);
  await run('git', ['-C', root, 'config', 'user.name', 'Workflow Test'], root);
  await run('git', ['-C', root, 'config', 'user.email', 'workflow@example.com'], root);
  await fs.writeFile(path.join(root, 'file.txt'), 'first\n', 'utf8');
  await run('git', ['-C', root, 'add', 'file.txt'], root);
  await run('git', ['-C', root, 'commit', '-m', 'first'], root);
  const firstOid = await run('git', ['-C', root, 'rev-parse', 'HEAD'], root);
  await fs.writeFile(path.join(root, 'file.txt'), 'second\n', 'utf8');
  await run('git', ['-C', root, 'commit', '-am', 'second'], root);
  const secondOid = await run('git', ['-C', root, 'rev-parse', 'HEAD'], root);

  return { firstOid, repoPath: root, secondOid };
}

test('createWorktree checks out the exact requested oid and writes a marker', async () => {
  const { firstOid, repoPath, secondOid } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    generation: 2,
    ref: firstOid,
    repoPath,
    task: 'Feature Alpha',
    worktreeRoot,
  });

  assert.equal(created.baseOid, firstOid);
  assert.notEqual(created.baseOid, secondOid);
  assert.equal(await resolveCommitOid(created.worktreePath, 'HEAD'), firstOid);
  assert.equal(created.branchName, deriveBranchName('Feature Alpha', 2));
  const marker = JSON.parse(await fs.readFile(created.markerPath, 'utf8'));
  assert.equal(marker.branchName, created.branchName);
  assert.equal(marker.baseOid, firstOid);
});

test('createWorktree fails on branch collision', async () => {
  const { repoPath } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const options = {
    generation: 1,
    repoPath,
    task: 'Collision',
    worktreeRoot,
  };

  await createWorktree(options);
  await assert.rejects(createWorktree(options), /already exists|fatal/i);
});

test('snapshotWorktree refuses dirty worktrees', async () => {
  const { repoPath } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    repoPath,
    task: 'Dirty Snapshot',
    worktreeRoot,
  });

  await fs.writeFile(path.join(created.worktreePath, 'dirty.txt'), 'nope\n', 'utf8');
  await assert.rejects(snapshotWorktree({ worktreePath: created.worktreePath }), /clean worktree/);
});

test('createWorktree rejects symlink worktree roots', async () => {
  const { repoPath } = await initRepo();
  const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-target-'));
  const symlinkRoot = `${targetRoot}-link`;
  await fs.symlink(targetRoot, symlinkRoot);

  await assert.rejects(createWorktree({
    repoPath,
    task: 'Symlink Root',
    worktreeRoot: symlinkRoot,
  }), /symlink paths are not allowed/);
});
