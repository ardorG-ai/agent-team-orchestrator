import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureGitRepository, projectContext } from '../src/project-context.mjs';

test('project context bootstraps Git and stores secrets outside the repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-context-'));
  const repo = join(root, 'repo');
  const stateRoot = join(root, 'state');
  const initialized = ensureGitRepository(repo);
  const context = projectContext(initialized, { stateRoot });

  assert.equal(context.repoRoot, initialized);
  assert.match(context.repoId, /^[a-f0-9]{24}$/);
  assert.match(readFileSync(context.keyPath, 'utf8'), /^[a-f0-9]{64}$/);
  assert.equal(statSync(context.keyPath).mode & 0o777, 0o600);
  assert.equal(context.keyPath.startsWith(context.repoRoot), false);
});

test('project context rejects repository-contained and symlink state roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-context-safety-'));
  const repo = ensureGitRepository(join(root, 'repo'));

  assert.throws(
    () => projectContext(repo, { stateRoot: join(repo, '.state') }),
    { code: 'unsafe_state_path' },
  );

  const target = join(root, 'state-target');
  const symlink = join(root, 'state-link');
  projectContext(repo, { stateRoot: target });
  symlinkSync(target, symlink);
  assert.throws(
    () => projectContext(repo, { stateRoot: symlink }),
    { code: 'unsafe_state_path' },
  );
});
