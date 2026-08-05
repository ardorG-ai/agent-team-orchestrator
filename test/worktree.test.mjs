import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  commitWorktreeCandidate,
  createWorktree,
  deriveBranchName,
  resolveCommitOid,
  snapshotWorktree,
} from '../src/worktree.mjs';

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

test('createWorktree disables repository checkout hooks', async () => {
  const { repoPath } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const markerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-checkout-hook-'));
  const markerPath = path.join(markerRoot, 'post-checkout');
  const hooksPath = await run('git', ['-C', repoPath, 'rev-parse', '--git-path', 'hooks'], repoPath);
  await fs.mkdir(hooksPath, { recursive: true });
  await fs.writeFile(
    path.join(hooksPath, 'post-checkout'),
    `#!/bin/sh\nprintf ran > '${markerPath}'\n`,
    'utf8',
  );
  await fs.chmod(path.join(hooksPath, 'post-checkout'), 0o755);

  await createWorktree({
    repoPath,
    task: 'Hook Free Checkout',
    worktreeRoot,
  });

  await assert.rejects(fs.access(markerPath), /ENOENT/);
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

test('commitWorktreeCandidate creates a controller-owned candidate from dirty changes', async () => {
  const { firstOid, repoPath } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    ref: firstOid,
    repoPath,
    task: 'Controller Candidate',
    worktreeRoot,
  });

  await fs.writeFile(path.join(created.worktreePath, 'file.txt'), 'controller-owned update\n', 'utf8');
  await fs.writeFile(path.join(created.worktreePath, 'notes.txt'), 'audit trail\n', 'utf8');

  const candidate = await commitWorktreeCandidate({
    baseOid: firstOid,
    commitMessage: 'Controller captures the candidate',
    scope: ['file.txt', 'notes.txt'],
    worktreePath: created.worktreePath,
  });

  assert.equal(candidate.baseOid, firstOid);
  assert.equal(candidate.parentOid, firstOid);
  assert.equal(candidate.parentCount, 1);
  assert.notEqual(candidate.candidateOid, firstOid);
  assert.deepEqual(candidate.changedPaths, ['file.txt', 'notes.txt']);
  assert.equal(await run('git', ['-C', created.worktreePath, 'status', '--porcelain=v1'], created.worktreePath), '');
  assert.equal(
    await run('git', ['-C', created.worktreePath, 'rev-list', '--parents', '-n', '1', 'HEAD'], created.worktreePath),
    `${candidate.candidateOid} ${firstOid}`,
  );
});

test('commitWorktreeCandidate rejects dirty paths that escape the allowed scope', async () => {
  const { firstOid, repoPath } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    ref: firstOid,
    repoPath,
    task: 'Scope Reject',
    worktreeRoot,
  });

  await fs.mkdir(path.join(created.worktreePath, 'docs'), { recursive: true });
  await fs.writeFile(path.join(created.worktreePath, 'docs', 'guide.md'), 'out of scope\n', 'utf8');

  await assert.rejects(
    commitWorktreeCandidate({
      baseOid: firstOid,
      scope: ['src/'],
      worktreePath: created.worktreePath,
    }),
    /escapes allowed scope/i,
  );
  assert.equal(await resolveCommitOid(created.worktreePath, 'HEAD'), firstOid);
});

test('commitWorktreeCandidate rejects tracked modifications outside the allowed scope', async () => {
  const { firstOid, repoPath } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    ref: firstOid,
    repoPath,
    task: 'Tracked Scope Reject',
    worktreeRoot,
  });

  await fs.writeFile(path.join(created.worktreePath, 'file.txt'), 'out of scope tracked edit\n', 'utf8');

  await assert.rejects(
    commitWorktreeCandidate({
      baseOid: firstOid,
      scope: ['docs/'],
      worktreePath: created.worktreePath,
    }),
    /escapes allowed scope/i,
  );
  assert.equal(await resolveCommitOid(created.worktreePath, 'HEAD'), firstOid);
});

test('commitWorktreeCandidate rejects unchanged worktrees', async () => {
  const { firstOid, repoPath } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    ref: firstOid,
    repoPath,
    task: 'No Changes',
    worktreeRoot,
  });

  await assert.rejects(
    commitWorktreeCandidate({
      baseOid: firstOid,
      worktreePath: created.worktreePath,
    }),
    /dirty change/i,
  );
});

test('commitWorktreeCandidate rejects child-staged index metadata', async () => {
  const { firstOid, repoPath } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    ref: firstOid,
    repoPath,
    task: 'Empty Tree Reject',
    worktreeRoot,
  });

  await fs.writeFile(path.join(created.worktreePath, 'file.txt'), 'temporarily staged\n', 'utf8');
  await run('git', ['-C', created.worktreePath, 'add', 'file.txt'], created.worktreePath);
  await fs.writeFile(path.join(created.worktreePath, 'file.txt'), 'first\n', 'utf8');

  await assert.rejects(
    commitWorktreeCandidate({
      baseOid: firstOid,
      scope: ['file.txt'],
      worktreePath: created.worktreePath,
    }),
    /refuses child-staged index changes/i,
  );
  assert.equal(await resolveCommitOid(created.worktreePath, 'HEAD'), firstOid);
});

test('commitWorktreeCandidate rejects empty scope entries without trimming', async () => {
  const { firstOid, repoPath } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    ref: firstOid,
    repoPath,
    task: 'Empty Scope Reject',
    worktreeRoot,
  });

  await fs.writeFile(path.join(created.worktreePath, 'file.txt'), 'scope failure\n', 'utf8');

  await assert.rejects(
    commitWorktreeCandidate({
      baseOid: firstOid,
      scope: [''],
      worktreePath: created.worktreePath,
    }),
    /must not be empty/i,
  );
});

test('commitWorktreeCandidate rejects backslash traversal segments cross-platform', async () => {
  const { firstOid, repoPath } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    ref: firstOid,
    repoPath,
    task: 'Backslash Traversal Reject',
    worktreeRoot,
  });

  await fs.writeFile(path.join(created.worktreePath, 'file.txt'), 'changed\n', 'utf8');
  await assert.rejects(
    commitWorktreeCandidate({
      baseOid: firstOid,
      scope: ['..\\outside.txt'],
      worktreePath: created.worktreePath,
    }),
    /unsafe path segment/i,
  );
});

test('commitWorktreeCandidate treats dot scope as the whole repository', async () => {
  const { firstOid, repoPath } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    ref: firstOid,
    repoPath,
    task: 'Dot Scope',
    worktreeRoot,
  });

  await fs.writeFile(path.join(created.worktreePath, 'whole-repo.txt'), 'allowed by dot scope\n', 'utf8');
  const candidate = await commitWorktreeCandidate({
    baseOid: firstOid,
    scope: ['.'],
    worktreePath: created.worktreePath,
  });

  assert.deepEqual(candidate.scope, []);
  assert.deepEqual(candidate.changedPaths, ['whole-repo.txt']);
});

test('commitWorktreeCandidate rejects child-created commits ahead of the exact base', async () => {
  const { firstOid, repoPath } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    ref: firstOid,
    repoPath,
    task: 'Child Commit Reject',
    worktreeRoot,
  });

  await fs.writeFile(path.join(created.worktreePath, 'file.txt'), 'child commit\n', 'utf8');
  await run('git', ['-C', created.worktreePath, 'commit', '-am', 'child-created'], created.worktreePath);

  await assert.rejects(
    commitWorktreeCandidate({
      baseOid: firstOid,
      worktreePath: created.worktreePath,
    }),
    /exact base oid/i,
  );
});

test('commitWorktreeCandidate audits both rename endpoints before committing', async () => {
  const { firstOid, repoPath } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    ref: firstOid,
    repoPath,
    task: 'Rename Audit',
    worktreeRoot,
  });

  await fs.rename(
    path.join(created.worktreePath, 'file.txt'),
    path.join(created.worktreePath, 'renamed.txt'),
  );

  const candidate = await commitWorktreeCandidate({
    baseOid: firstOid,
    scope: ['file.txt', 'renamed.txt'],
    worktreePath: created.worktreePath,
  });

  assert.deepEqual(candidate.changedPaths, ['file.txt', 'renamed.txt']);
  assert.equal(
    await run('git', ['-C', created.worktreePath, 'show', '--name-status', '--format=%P', 'HEAD'], created.worktreePath),
    `${firstOid}\n\nR100\tfile.txt\trenamed.txt`,
  );
  assert.equal(candidate.parentCount, 1);
});

test('commitWorktreeCandidate avoids clean filters and preserves executable and symlink entries', async () => {
  const { repoPath } = await initRepo();
  const markerPath = path.join(repoPath, 'clean-filter.marker');
  const filterScriptPath = path.join(repoPath, 'tripwire-filter.sh');
  await fs.writeFile(filterScriptPath, `#!/bin/sh
printf clean-ran > '${markerPath}'
cat
`, 'utf8');
  await fs.chmod(filterScriptPath, 0o755);
  await run('git', ['-C', repoPath, 'config', 'filter.tripwire.clean', filterScriptPath], repoPath);
  await fs.writeFile(path.join(repoPath, '.gitattributes'), 'notes.txt filter=tripwire\n', 'utf8');
  await run('git', ['-C', repoPath, 'add', '.gitattributes'], repoPath);
  await run('git', ['-C', repoPath, 'commit', '-m', 'attrs'], repoPath);
  const baseOid = await run('git', ['-C', repoPath, 'rev-parse', 'HEAD'], repoPath);

  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    ref: baseOid,
    repoPath,
    task: 'Filter Free Candidate',
    worktreeRoot,
  });

  const scriptPath = path.join(created.worktreePath, 'script.sh');
  await fs.writeFile(scriptPath, '#!/bin/sh\necho hi\n', 'utf8');
  await fs.chmod(scriptPath, 0o755);
  await fs.writeFile(path.join(created.worktreePath, 'notes.txt'), 'must bypass clean filter\n', 'utf8');
  await fs.symlink('script.sh', path.join(created.worktreePath, 'script.link'));

  const candidate = await commitWorktreeCandidate({
    baseOid,
    scope: ['notes.txt', 'script.link', 'script.sh'],
    worktreePath: created.worktreePath,
  });

  await assert.rejects(fs.access(markerPath), /ENOENT/);
  assert.deepEqual(candidate.changedPaths, ['notes.txt', 'script.link', 'script.sh']);
  assert.equal(
    await run('git', ['-C', created.worktreePath, 'ls-tree', '-r', 'HEAD', '--', 'notes.txt', 'script.link', 'script.sh'], created.worktreePath),
    [
      `100644 blob ${await run('git', ['-C', created.worktreePath, 'rev-parse', 'HEAD:notes.txt'], created.worktreePath)}\tnotes.txt`,
      `120000 blob ${await run('git', ['-C', created.worktreePath, 'rev-parse', 'HEAD:script.link'], created.worktreePath)}\tscript.link`,
      `100755 blob ${await run('git', ['-C', created.worktreePath, 'rev-parse', 'HEAD:script.sh'], created.worktreePath)}\tscript.sh`,
    ].join('\n'),
  );
  assert.equal(await run('git', ['-C', created.worktreePath, 'show', 'HEAD:script.link'], created.worktreePath), 'script.sh');
});

test('commitWorktreeCandidate ignores untracked files matched by repository policy and snapshotWorktree stays clean', async () => {
  const { repoPath } = await initRepo();
  await fs.writeFile(path.join(repoPath, '.gitignore'), 'ignored/\n', 'utf8');
  await run('git', ['-C', repoPath, 'add', '.gitignore'], repoPath);
  await run('git', ['-C', repoPath, 'commit', '-m', 'ignore scratch'], repoPath);
  const baseOid = await run('git', ['-C', repoPath, 'rev-parse', 'HEAD'], repoPath);

  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    ref: baseOid,
    repoPath,
    task: 'Ignored Untracked Policy',
    worktreeRoot,
  });

  await fs.mkdir(path.join(created.worktreePath, 'ignored'), { recursive: true });
  await fs.writeFile(path.join(created.worktreePath, 'ignored', 'cache.txt'), 'ignored noise\n', 'utf8');
  await fs.writeFile(path.join(created.worktreePath, 'file.txt'), 'candidate update\n', 'utf8');

  const candidate = await commitWorktreeCandidate({
    baseOid,
    scope: ['file.txt'],
    worktreePath: created.worktreePath,
  });

  const snapshot = await snapshotWorktree({ worktreePath: created.worktreePath });
  assert.equal(snapshot.clean, true);
  assert.equal(snapshot.candidateOid, candidate.candidateOid);
  assert.deepEqual(candidate.changedPaths, ['file.txt']);
  assert.equal(await run('git', ['-C', created.worktreePath, 'status', '--porcelain'], created.worktreePath), '');
  assert.equal(
    await run('git', ['-C', created.worktreePath, 'check-ignore', '--verbose', 'ignored/cache.txt'], created.worktreePath),
    `.gitignore:1:ignored/\tignored/cache.txt`,
  );
});

test('commitWorktreeCandidate captures a tracked file-to-symlink type flip on POSIX', {
  skip: process.platform === 'win32',
}, async () => {
  const { firstOid, repoPath } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    ref: firstOid,
    repoPath,
    task: 'File To Symlink Flip',
    worktreeRoot,
  });

  await fs.unlink(path.join(created.worktreePath, 'file.txt'));
  await fs.symlink('symlink-target.txt', path.join(created.worktreePath, 'file.txt'));

  const candidate = await commitWorktreeCandidate({
    baseOid: firstOid,
    scope: ['file.txt'],
    worktreePath: created.worktreePath,
  });

  assert.deepEqual(candidate.changedPaths, ['file.txt']);
  assert.equal(
    await run('git', ['-C', created.worktreePath, 'ls-tree', '-r', 'HEAD', '--', 'file.txt'], created.worktreePath),
    `120000 blob ${await run('git', ['-C', created.worktreePath, 'rev-parse', 'HEAD:file.txt'], created.worktreePath)}\tfile.txt`,
  );
  assert.equal(await run('git', ['-C', created.worktreePath, 'show', 'HEAD:file.txt'], created.worktreePath), 'symlink-target.txt');
  assert.equal(await run('git', ['-C', created.worktreePath, 'status', '--porcelain'], created.worktreePath), '');
});

test('commitWorktreeCandidate captures a tracked executable-bit change on POSIX', {
  skip: process.platform === 'win32',
}, async () => {
  const { firstOid, repoPath } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    ref: firstOid,
    repoPath,
    task: 'Executable Bit Change',
    worktreeRoot,
  });

  await fs.chmod(path.join(created.worktreePath, 'file.txt'), 0o755);
  const candidate = await commitWorktreeCandidate({
    baseOid: firstOid,
    scope: ['file.txt'],
    worktreePath: created.worktreePath,
  });

  assert.deepEqual(candidate.changedPaths, ['file.txt']);
  assert.match(
    await run('git', ['-C', created.worktreePath, 'ls-tree', 'HEAD', '--', 'file.txt'], created.worktreePath),
    /^100755 blob /u,
  );
});

test('commitWorktreeCandidate captures a tracked symlink target change on POSIX', {
  skip: process.platform === 'win32',
}, async () => {
  const { repoPath } = await initRepo();
  await fs.symlink('first-target.txt', path.join(repoPath, 'tracked.link'));
  await run('git', ['-C', repoPath, 'add', 'tracked.link'], repoPath);
  await run('git', ['-C', repoPath, 'commit', '-m', 'track symlink'], repoPath);
  const baseOid = await run('git', ['-C', repoPath, 'rev-parse', 'HEAD'], repoPath);
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    ref: baseOid,
    repoPath,
    task: 'Symlink Target Change',
    worktreeRoot,
  });

  const linkPath = path.join(created.worktreePath, 'tracked.link');
  await fs.unlink(linkPath);
  await fs.symlink('second-target.txt', linkPath);
  const candidate = await commitWorktreeCandidate({
    baseOid,
    scope: ['tracked.link'],
    worktreePath: created.worktreePath,
  });

  assert.deepEqual(candidate.changedPaths, ['tracked.link']);
  assert.equal(await run('git', ['-C', created.worktreePath, 'show', 'HEAD:tracked.link'], created.worktreePath), 'second-target.txt');
});

test('commitWorktreeCandidate disables index and reference hooks during publication', async () => {
  const { firstOid, repoPath } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    ref: firstOid,
    repoPath,
    task: 'Hook Free Candidate',
    worktreeRoot,
  });
  const markerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-hook-markers-'));
  const hooksPath = await run('git', ['-C', repoPath, 'rev-parse', '--git-path', 'hooks'], repoPath);
  const postIndexMarker = path.join(markerRoot, 'post-index-change');
  const referenceMarker = path.join(markerRoot, 'reference-transaction');
  await fs.mkdir(hooksPath, { recursive: true });
  await fs.writeFile(
    path.join(hooksPath, 'post-index-change'),
    `#!/bin/sh\nprintf ran > '${postIndexMarker}'\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(hooksPath, 'reference-transaction'),
    `#!/bin/sh\nprintf ran > '${referenceMarker}'\ncat >/dev/null\n`,
    'utf8',
  );
  await fs.chmod(path.join(hooksPath, 'post-index-change'), 0o755);
  await fs.chmod(path.join(hooksPath, 'reference-transaction'), 0o755);

  await fs.writeFile(path.join(created.worktreePath, 'file.txt'), 'hook-free update\n', 'utf8');
  const candidate = await commitWorktreeCandidate({
    baseOid: firstOid,
    scope: ['file.txt'],
    worktreePath: created.worktreePath,
  });

  assert.notEqual(candidate.candidateOid, firstOid);
  await assert.rejects(fs.access(postIndexMarker), /ENOENT/);
  await assert.rejects(fs.access(referenceMarker), /ENOENT/);
});

test('commitWorktreeCandidate fails closed when a late write lands after publication and leaves HEAD recoverable', {
  skip: process.platform === 'win32',
}, async () => {
  const { firstOid, repoPath } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    ref: firstOid,
    repoPath,
    task: 'Late Write Candidate',
    worktreeRoot,
  });

  const targetPath = path.join(created.worktreePath, 'file.txt');
  await fs.writeFile(targetPath, 'controller-owned update\n', 'utf8');

  const { resolveExecutable, runSubprocess } = await import('../src/subprocess.mjs');
  const wrapperRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-git-wrapper-'));
  const wrapperPath = path.join(wrapperRoot, 'git');
  const realGitPath = resolveExecutable('git');
  const markerPath = path.join(wrapperRoot, 'late-write.marker');
  const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
  const worktreeModuleUrl = pathToFileURL(path.join(process.cwd(), 'src/worktree.mjs')).href;
  const subprocessModuleUrl = pathToFileURL(path.join(process.cwd(), 'src/subprocess.mjs')).href;
  const childScriptPath = path.join(wrapperRoot, 'late-write-check.mjs');

  await fs.writeFile(
    wrapperPath,
    `#!/bin/sh
set -eu
${shellQuote(realGitPath)} "$@"
status=$?
case " $* " in
  *" update-ref "*)
    if [ "$status" -eq 0 ] && [ ! -e ${shellQuote(markerPath)} ]; then
      printf 'late mutation\\n' >> ${shellQuote(targetPath)}
      : > ${shellQuote(markerPath)}
    fi
    ;;
esac
exit "$status"
`,
    'utf8',
  );
  await fs.chmod(wrapperPath, 0o755);

  await fs.writeFile(
    childScriptPath,
    `import { commitWorktreeCandidate, resolveCommitOid } from ${JSON.stringify(worktreeModuleUrl)};
import { runSubprocess } from ${JSON.stringify(subprocessModuleUrl)};

const [worktreePath, baseOid] = process.argv.slice(2);

const result = await (async () => {
  try {
    await commitWorktreeCandidate({
      baseOid,
      commitMessage: 'Controller captures the candidate',
      scope: ['file.txt'],
      worktreePath,
    });
    return {
      ok: true,
      headAfter: await resolveCommitOid(worktreePath, 'HEAD'),
      status: '',
    };
  } catch (error) {
    const headAfter = await resolveCommitOid(worktreePath, 'HEAD');
    const statusResult = await runSubprocess({
      command: 'git',
      args: ['-C', worktreePath, 'status', '--porcelain'],
      cwd: worktreePath,
      maxStderrBytes: 1024 * 1024,
      maxStdoutBytes: 1024 * 1024,
      timeoutMs: 10_000,
    });
    return {
      headAfter,
      message: error instanceof Error ? error.message : String(error),
      ok: false,
      status: statusResult.success ? statusResult.stdout.trim() : 'ERR',
    };
  }
})();

process.stdout.write(JSON.stringify(result) + '\\n');
`,
    'utf8',
  );

  const child = await runSubprocess({
    command: process.execPath,
    args: [childScriptPath, created.worktreePath, firstOid],
    cwd: created.worktreePath,
    env: {
      PATH: `${wrapperRoot}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    maxStderrBytes: 1024 * 1024,
    maxStdoutBytes: 1024 * 1024,
    timeoutMs: 10_000,
  });

  assert.equal(child.success, true, child.stderr || child.stdout);
  const published = JSON.parse(child.stdout.trim());
  assert.equal(published.ok, false, published.message);
  assert.match(published.message, /changed after publication|clean worktree/i);
  assert.notEqual(published.headAfter, firstOid);
  assert.match(published.status, /file\.txt/u);
  assert.equal(
    await run('git', ['-C', created.worktreePath, 'rev-list', '--parents', '-n', '1', 'HEAD'], created.worktreePath),
    `${published.headAfter} ${firstOid}`,
  );

  await run('git', ['-C', created.worktreePath, 'reset', '--hard', firstOid], created.worktreePath);
  assert.equal(await resolveCommitOid(created.worktreePath, 'HEAD'), firstOid);
  assert.equal(await run('git', ['-C', created.worktreePath, 'status', '--porcelain'], created.worktreePath), '');
});

test('commitWorktreeCandidate preserves literal backslashes in POSIX repo paths', {
  skip: process.platform === 'win32',
}, async () => {
  const { firstOid, repoPath } = await initRepo();
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-managed-'));
  const created = await createWorktree({
    ref: firstOid,
    repoPath,
    task: 'Literal Backslash',
    worktreeRoot,
  });

  const literalPath = 'literal\\name.txt';
  await fs.writeFile(path.join(created.worktreePath, literalPath), 'backslash stays literal\n', 'utf8');

  const candidate = await commitWorktreeCandidate({
    baseOid: firstOid,
    scope: [literalPath],
    worktreePath: created.worktreePath,
  });

  assert.deepEqual(candidate.changedPaths, [literalPath]);
  assert.equal(
    await run('git', ['-C', created.worktreePath, 'show', `HEAD:${literalPath}`], created.worktreePath),
    'backslash stays literal',
  );
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
