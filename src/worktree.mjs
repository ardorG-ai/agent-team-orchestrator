import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import runSubprocess from './subprocess.mjs';

function slugifyTask(task) {
  return String(task ?? 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
}

async function assertPathNotSymlink(targetPath) {
  try {
    const stats = await fs.lstat(targetPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`symlink paths are not allowed: ${targetPath}`);
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }
}

async function assertManagedSubpathSafe(rootRealPath, targetPath) {
  const relativePath = path.relative(rootRealPath, targetPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('managed worktree path escapes the configured root');
  }

  let current = rootRealPath;
  for (const part of relativePath.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    await assertPathNotSymlink(current);
  }
}

async function ensureManagedRoot(worktreeRoot) {
  await assertPathNotSymlink(worktreeRoot);
  await fs.mkdir(worktreeRoot, { recursive: true });
  return fs.realpath(worktreeRoot);
}

async function runGit(args, cwd, options = {}) {
  const {
    env = {},
    trim = true,
    maxStdoutBytes = 512 * 1024,
    maxStderrBytes = 512 * 1024,
    timeoutMs = 20_000,
    input = '',
  } = options;
  const result = await runSubprocess({
    command: 'git',
    args: ['-C', cwd, ...args],
    cwd,
    env,
    envAllowlist: Object.keys(env),
    input,
    maxStdoutBytes,
    maxStderrBytes,
    timeoutMs,
  });

  if (!result.success) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git exited with code ${result.exitCode}`;
    const error = new Error(detail);
    error.result = result;
    throw error;
  }

  return trim ? result.stdout.trim() : result.stdout;
}

const MAX_REPO_PATH_BYTES = 4096;

function rejectUnsafeRepoPath(candidate, label) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  if (candidate.includes('\0')) {
    throw new Error(`${label} contains an embedded NUL byte`);
  }

  if (Buffer.byteLength(candidate, 'utf8') > MAX_REPO_PATH_BYTES) {
    throw new Error(`${label} exceeds the maximum safe path length`);
  }

  const platformCandidate = process.platform === 'win32'
    ? candidate.replaceAll('\\', '/')
    : candidate;
  if (path.posix.isAbsolute(platformCandidate) || path.win32.isAbsolute(candidate)) {
    throw new Error(`${label} must be repository-relative`);
  }

  const platformSegments = platformCandidate.split('/');
  const traversalSegments = candidate.split(/[\\/]/u);
  if (
    platformSegments.some((segment) => segment === '' || segment === '.' || segment === '..')
    || traversalSegments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} contains an unsafe path segment`);
  }

  return platformCandidate;
}

function normalizeScopeEntries(scope) {
  if (!Array.isArray(scope) || scope.length === 0) return [];
  if (scope.length > 64) {
    throw new Error('scope must contain at most 64 entries');
  }
  const normalized = [];

  for (const entry of scope) {
    if (typeof entry !== 'string') {
      throw new TypeError('scope entries must be strings');
    }

    if (entry.length === 0) {
      throw new Error('scope entries must not be empty');
    }

    if (entry === '.' || entry === './') {
      return [];
    }

    const normalizedEntry = rejectUnsafeRepoPath(entry.replace(/\/+$/u, ''), 'scope entry');
    normalized.push(normalizedEntry);
  }

  return [...new Set(normalized)];
}

function pathWithinScope(candidatePath, scope) {
  if (scope.length === 0) return true;
  return scope.some((entry) => candidatePath === entry || candidatePath.startsWith(`${entry}/`));
}

const INDEX_DEBUG_METADATA_PATTERN = /^  ctime: (\d+):(\d+)\n  mtime: (\d+):(\d+)\n  dev: (\d+)\tino: (\d+)\n  uid: (\d+)\tgid: (\d+)\n  size: (\d+)\tflags: ([0-9a-f]+)\n/u;

function parseNulSeparatedPaths(raw, label) {
  if (raw === '') return [];
  const fields = raw.split('\0');
  if (fields.at(-1) === '') fields.pop();
  return fields.map((candidate) => rejectUnsafeRepoPath(candidate, label));
}

async function listIndexEntries(worktreePath) {
  const raw = await runGit(
    ['ls-files', '--stage', '--debug', '-z'],
    worktreePath,
    {
      env: { LC_ALL: 'C' },
      maxStdoutBytes: 32 * 1024 * 1024,
      trim: false,
    },
  );
  const entries = [];
  let cursor = 0;

  while (cursor < raw.length) {
    const pathEnd = raw.indexOf('\0', cursor);
    if (pathEnd === -1) {
      throw new Error('unable to parse git index entry path');
    }

    const header = raw.slice(cursor, pathEnd);
    const tabIndex = header.indexOf('\t');
    if (tabIndex === -1) {
      throw new Error('unable to parse git index entry header');
    }
    const prefix = header.slice(0, tabIndex).split(' ');
    if (prefix.length !== 3 || !/^\d{6}$/u.test(prefix[0]) || !/^[0-9a-f]+$/u.test(prefix[1])) {
      throw new Error('unable to parse git index entry metadata');
    }
    const stage = Number(prefix[2]);
    if (!Number.isInteger(stage) || stage < 0 || stage > 3) {
      throw new Error('unable to parse git index entry stage');
    }

    cursor = pathEnd + 1;
    const metadataMatch = raw.slice(cursor).match(INDEX_DEBUG_METADATA_PATTERN);
    if (!metadataMatch) {
      throw new Error('unable to parse git index stat metadata');
    }
    cursor += metadataMatch[0].length;

    entries.push({
      ctimeNs: (BigInt(metadataMatch[1]) * 1_000_000_000n) + BigInt(metadataMatch[2]),
      dev: BigInt(metadataMatch[5]),
      ino: BigInt(metadataMatch[6]),
      mode: prefix[0],
      mtimeNs: (BigInt(metadataMatch[3]) * 1_000_000_000n) + BigInt(metadataMatch[4]),
      objectId: prefix[1],
      repoPath: rejectUnsafeRepoPath(header.slice(tabIndex + 1), 'index path'),
      size: BigInt(metadataMatch[9]),
      stage,
    });
  }

  return entries;
}

async function listUntrackedPaths(worktreePath) {
  const raw = await runGit(
    ['ls-files', '--others', '--exclude-standard', '-z'],
    worktreePath,
    {
      maxStdoutBytes: 32 * 1024 * 1024,
      trim: false,
    },
  );
  return parseNulSeparatedPaths(raw, 'untracked path');
}

async function readBooleanConfig(worktreePath, name, defaultValue) {
  const value = await runGit(
    ['config', '--type=bool', `--default=${defaultValue ? 'true' : 'false'}`, '--get', name],
    worktreePath,
  );
  return value === 'true';
}

function indexStatMatches(entry, stats) {
  const uint32Mask = 0xffff_ffffn;
  return entry.ctimeNs === stats.ctimeNs
    && entry.mtimeNs === stats.mtimeNs
    && entry.size === stats.size
    && (entry.dev & uint32Mask) === (stats.dev & uint32Mask)
    && (entry.ino & uint32Mask) === (stats.ino & uint32Mask);
}

function statTypeMatchesMode(stats, mode, trustSymlinks) {
  if (mode === '160000') return stats.isDirectory();
  if (mode === '120000') return stats.isSymbolicLink() || (!trustSymlinks && stats.isFile());
  if (mode === '100644' || mode === '100755') return stats.isFile();
  return false;
}

async function indexEntryMatchesFilesystem({
  entry,
  stats,
  trustFileMode,
  trustSymlinks,
  worktreePath,
}) {
  if (!statTypeMatchesMode(stats, entry.mode, trustSymlinks)) return false;
  if (indexStatMatches(entry, stats)) return true;

  if (entry.mode === '160000') {
    const submodulePath = repoPathToFsPath(worktreePath, entry.repoPath);
    try {
      const snapshot = await snapshotWorktree({ worktreePath: submodulePath });
      return snapshot.candidateOid === entry.objectId;
    } catch {
      return false;
    }
  }

  const filesystemEntry = await hashFilesystemEntry(worktreePath, entry.repoPath, {
    writeObject: false,
  });
  if (filesystemEntry.remove || filesystemEntry.objectId !== entry.objectId) return false;
  if (entry.mode === '120000' && !trustSymlinks && filesystemEntry.mode === '100644') return true;
  if (!trustFileMode && entry.mode.startsWith('100') && filesystemEntry.mode?.startsWith('100')) return true;
  return filesystemEntry.mode === entry.mode;
}

async function inspectWorktreeAgainstIndex(worktreePath) {
  const [entries, untrackedPaths, trustFileMode, trustSymlinks] = await Promise.all([
    listIndexEntries(worktreePath),
    listUntrackedPaths(worktreePath),
    readBooleanConfig(worktreePath, 'core.filemode', true),
    readBooleanConfig(worktreePath, 'core.symlinks', true),
  ]);
  const changedPaths = new Set(untrackedPaths);

  for (const entry of entries) {
    if (entry.stage !== 0) {
      throw new Error(`candidate publication refuses unmerged index entry: ${entry.repoPath}`);
    }

    const filesystemPath = repoPathToFsPath(worktreePath, entry.repoPath);
    let stats;
    try {
      stats = await fs.lstat(filesystemPath, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        changedPaths.add(entry.repoPath);
        continue;
      }
      throw error;
    }

    if (!await indexEntryMatchesFilesystem({
      entry,
      stats,
      trustFileMode,
      trustSymlinks,
      worktreePath,
    })) {
      changedPaths.add(entry.repoPath);
    }
  }

  return [...changedPaths].sort();
}

function assertPathsWithinScope(changedPaths, normalizedScope) {
  const outOfScopePath = changedPaths.find((candidatePath) => !pathWithinScope(candidatePath, normalizedScope));
  if (outOfScopePath) {
    throw new Error(`candidate change escapes allowed scope: ${outOfScopePath}`);
  }

  return changedPaths;
}

function repoPathToFsPath(rootPath, repoPath) {
  const filesystemPath = path.resolve(rootPath, ...repoPath.split('/'));
  const relativePath = path.relative(rootPath, filesystemPath);
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new Error(`candidate path escapes the worktree root: ${repoPath}`);
  }
  return filesystemPath;
}

function fileModeFromStat(stats) {
  if (stats.isSymbolicLink()) return '120000';
  if (!stats.isFile()) {
    throw new Error('candidate commit only supports regular files and symlinks');
  }

  return (stats.mode & 0o111) !== 0 ? '100755' : '100644';
}

async function hashFilesystemEntry(worktreePath, repoPath, options = {}) {
  const { writeObject = true } = options;
  const filesystemPath = repoPathToFsPath(worktreePath, repoPath);
  let stats;
  try {
    stats = await fs.lstat(filesystemPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { mode: null, objectId: null, repoPath, remove: true };
    }
    throw error;
  }

  const mode = fileModeFromStat(stats);
  if (mode === '120000') {
    const target = await fs.readlink(filesystemPath, { encoding: 'buffer' });
    const objectId = await runGit(
      ['hash-object', ...(writeObject ? ['-w'] : []), '--stdin'],
      worktreePath,
      {
        input: target,
        trim: true,
      },
    );
    return { mode, objectId, repoPath, remove: false };
  }

  const objectId = await runGit(
    ['hash-object', ...(writeObject ? ['-w'] : []), '--no-filters', '--', filesystemPath],
    worktreePath,
  );
  return { mode, objectId, repoPath, remove: false };
}

async function buildCandidateTree({ baseOid, changedPaths, worktreePath }) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-index-'));
  const tempIndexPath = path.join(tempRoot, 'index');
  const env = { GIT_INDEX_FILE: tempIndexPath };

  try {
    await runGit(['-c', 'core.hooksPath=/dev/null', 'read-tree', baseOid], worktreePath, { env });

    for (const changedPath of changedPaths) {
      const entry = await hashFilesystemEntry(worktreePath, changedPath);
      if (entry.remove) {
        await runGit(
          ['-c', 'core.hooksPath=/dev/null', 'update-index', '--force-remove', '--', entry.repoPath],
          worktreePath,
          { env },
        );
        continue;
      }

      await runGit(
        [
          '-c',
          'core.hooksPath=/dev/null',
          'update-index',
          '--add',
          '--replace',
          '--cacheinfo',
          entry.mode,
          entry.objectId,
          entry.repoPath,
        ],
        worktreePath,
        { env },
      );
    }

    return await runGit(['write-tree'], worktreePath, { env });
  } finally {
    await fs.rm(tempRoot, { force: true, recursive: true });
  }
}

async function getSymbolicHeadRef(worktreePath) {
  return runGit(['symbolic-ref', '--quiet', 'HEAD'], worktreePath);
}

export async function resolveCommitOid(repoPath, ref = 'HEAD') {
  return runGit(['rev-parse', '--verify', `${ref}^{commit}`], repoPath);
}

export async function getRepoIdentity(repoPath) {
  const topLevel = await runGit(['rev-parse', '--show-toplevel'], repoPath);
  const commonDirRaw = await runGit(['rev-parse', '--git-common-dir'], repoPath);
  const commonDir = path.resolve(topLevel, commonDirRaw);

  return {
    commonDir: await fs.realpath(commonDir),
    repoPath: await fs.realpath(topLevel),
    repoName: path.basename(topLevel),
  };
}

export function deriveBranchName(task, generation = 1) {
  return `${slugifyTask(task)}-g${Number(generation) || 1}`;
}

function buildManagedPath(rootRealPath, repoName, branchName) {
  const safeRepo = slugifyTask(repoName);
  return path.join(rootRealPath, safeRepo, branchName);
}

async function writeMarker(markerRoot, branchName, data) {
  await fs.mkdir(markerRoot, { recursive: true });
  const markerPath = path.join(markerRoot, `${branchName}.json`);
  await fs.writeFile(markerPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return markerPath;
}

export async function createWorktree(options) {
  const {
    generation = 1,
    ref = 'HEAD',
    repoPath,
    task,
    worktreeRoot,
  } = options ?? {};

  if (!repoPath || !worktreeRoot || !task) {
    throw new TypeError('createWorktree requires repoPath, worktreeRoot, and task');
  }

  const { commonDir, repoName, repoPath: realRepoPath } = await getRepoIdentity(repoPath);
  const baseOid = await resolveCommitOid(realRepoPath, ref);
  const rootRealPath = await ensureManagedRoot(worktreeRoot);
  const branchName = deriveBranchName(task, generation);
  const worktreePath = buildManagedPath(rootRealPath, repoName, branchName);

  await assertManagedSubpathSafe(rootRealPath, worktreePath);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  await runGit(
    ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-b', branchName, worktreePath, baseOid],
    realRepoPath,
  );

  const createdHead = await resolveCommitOid(worktreePath, 'HEAD');
  if (createdHead !== baseOid) {
    throw new Error(`worktree HEAD mismatch: expected ${baseOid}, got ${createdHead}`);
  }

  const createdCommonDir = (await getRepoIdentity(worktreePath)).commonDir;
  if (createdCommonDir !== commonDir) {
    throw new Error(`worktree common dir mismatch: expected ${commonDir}, got ${createdCommonDir}`);
  }

  const markerPath = await writeMarker(path.join(rootRealPath, '.markers'), branchName, {
    baseOid,
    branchName,
    commonDir,
    createdAt: new Date().toISOString(),
    repoPath: realRepoPath,
    task,
    worktreePath,
  });

  return {
    baseOid,
    branchName,
    commonDir,
    markerPath,
    repoPath: realRepoPath,
    worktreePath,
  };
}

export async function snapshotWorktree(options) {
  const { worktreePath } = options ?? {};

  if (!worktreePath) {
    throw new TypeError('snapshotWorktree requires worktreePath');
  }

  const realWorktreePath = await fs.realpath(worktreePath);
  const candidateOid = await resolveCommitOid(realWorktreePath, 'HEAD');
  const [headTreeOid, indexTreeOid] = await Promise.all([
    runGit(['rev-parse', '--verify', `${candidateOid}^{tree}`], realWorktreePath),
    runGit(['write-tree'], realWorktreePath),
  ]);
  if (indexTreeOid !== headTreeOid) {
    throw new Error('snapshot requires the index to match the exact HEAD tree');
  }

  const changedPaths = await inspectWorktreeAgainstIndex(realWorktreePath);
  if (changedPaths.length > 0) {
    throw new Error('snapshot requires a clean worktree');
  }

  const [headAfterScan, indexTreeAfterScan] = await Promise.all([
    resolveCommitOid(realWorktreePath, 'HEAD'),
    runGit(['write-tree'], realWorktreePath),
  ]);
  if (headAfterScan !== candidateOid) {
    throw new Error('snapshot HEAD changed while the controller was verifying it');
  }
  if (indexTreeAfterScan !== headTreeOid) {
    throw new Error('snapshot index changed while the controller was verifying it');
  }

  return {
    candidateOid,
    clean: true,
    worktreePath: realWorktreePath,
  };
}

export async function commitWorktreeCandidate(options) {
  const {
    authorEmail = 'controller@local.invalid',
    authorName = 'Agent Team Controller',
    baseOid,
    commitMessage = 'Create candidate commit',
    scope = [],
    worktreePath,
  } = options ?? {};

  if (!worktreePath || !baseOid) {
    throw new TypeError('commitWorktreeCandidate requires worktreePath and baseOid');
  }

  if (typeof commitMessage !== 'string' || commitMessage.trim() === '') {
    throw new TypeError('commitWorktreeCandidate requires a non-empty commitMessage');
  }

  const realWorktreePath = await fs.realpath(worktreePath);
  const headBefore = await resolveCommitOid(realWorktreePath, 'HEAD');
  if (headBefore !== baseOid) {
    throw new Error(`candidate commit requires HEAD to match exact base OID ${baseOid}`);
  }

  const baseTreeOid = await runGit(
    ['rev-parse', '--verify', `${baseOid}^{tree}`],
    realWorktreePath,
  );
  const indexTreeBefore = await runGit(['write-tree'], realWorktreePath);
  if (indexTreeBefore !== baseTreeOid) {
    throw new Error('candidate publication refuses child-staged index changes');
  }

  const changedPaths = await inspectWorktreeAgainstIndex(realWorktreePath);
  if (changedPaths.length === 0) {
    throw new Error('candidate commit requires at least one dirty change');
  }

  const normalizedScope = normalizeScopeEntries(scope);
  assertPathsWithinScope(changedPaths, normalizedScope);
  const candidateTreeOid = await buildCandidateTree({
    baseOid,
    changedPaths,
    worktreePath: realWorktreePath,
  });
  if (candidateTreeOid === baseTreeOid) {
    throw new Error('candidate commit must change the exact base tree');
  }
  const indexTreeBeforePublish = await runGit(['write-tree'], realWorktreePath);
  if (indexTreeBeforePublish !== baseTreeOid) {
    throw new Error('candidate publication refuses child-staged index changes');
  }
  const publishChangedPaths = await inspectWorktreeAgainstIndex(realWorktreePath);
  assertPathsWithinScope(publishChangedPaths, normalizedScope);
  if (JSON.stringify(publishChangedPaths) !== JSON.stringify(changedPaths)) {
    throw new Error('candidate change set changed while the controller was publishing it');
  }
  const verifiedCandidateTreeOid = await buildCandidateTree({
    baseOid,
    changedPaths: publishChangedPaths,
    worktreePath: realWorktreePath,
  });
  if (verifiedCandidateTreeOid !== candidateTreeOid) {
    throw new Error('candidate content changed while the controller was publishing it');
  }
  const candidateOid = await runGit(
    ['commit-tree', candidateTreeOid, '-p', baseOid],
    realWorktreePath,
    {
      env: {
        GIT_AUTHOR_EMAIL: authorEmail,
        GIT_AUTHOR_NAME: authorName,
        GIT_COMMITTER_EMAIL: authorEmail,
        GIT_COMMITTER_NAME: authorName,
      },
      input: `${commitMessage}\n`,
    },
  );
  if (candidateOid === baseOid) {
    throw new Error('candidate commit must create a new candidate OID');
  }

  const headRef = await getSymbolicHeadRef(realWorktreePath);
  await runGit(
    ['-c', 'core.hooksPath=/dev/null', 'update-ref', headRef, candidateOid, baseOid],
    realWorktreePath,
  );
  await runGit(
    ['-c', 'core.hooksPath=/dev/null', 'read-tree', candidateOid],
    realWorktreePath,
  );

  const parentLine = await runGit(['rev-list', '--parents', '-n', '1', candidateOid], realWorktreePath);
  const parentTokens = parentLine.split(' ').filter(Boolean);
  const parentOids = parentTokens.slice(1);
  if (parentOids.length !== 1) {
    throw new Error(`candidate commit must have exactly one parent, got ${parentOids.length}`);
  }

  const [parentOid] = parentOids;
  if (parentOid !== baseOid) {
    throw new Error(`candidate parent mismatch: expected ${baseOid}, got ${parentOid}`);
  }

  const indexTreeOid = await runGit(['write-tree'], realWorktreePath);
  if (indexTreeOid !== candidateTreeOid) {
    throw new Error(`candidate index mismatch: expected tree ${candidateTreeOid}, got ${indexTreeOid}`);
  }

  const headAfter = await resolveCommitOid(realWorktreePath, 'HEAD');
  if (headAfter !== candidateOid) {
    throw new Error(`candidate branch update mismatch: expected ${candidateOid}, got ${headAfter}`);
  }

  const postPublishTreeOid = await buildCandidateTree({
    baseOid,
    changedPaths,
    worktreePath: realWorktreePath,
  });
  if (postPublishTreeOid !== candidateTreeOid) {
    const error = new Error('candidate content changed after publication');
    error.candidateOid = candidateOid;
    error.worktreePath = realWorktreePath;
    throw error;
  }

  let verifiedSnapshot;
  try {
    verifiedSnapshot = await snapshotWorktree({ worktreePath: realWorktreePath });
  } catch (error) {
    error.candidateOid = candidateOid;
    error.worktreePath = realWorktreePath;
    throw error;
  }
  if (verifiedSnapshot.candidateOid !== candidateOid) {
    throw new Error(
      `candidate snapshot mismatch: expected ${candidateOid}, got ${verifiedSnapshot.candidateOid}`,
    );
  }

  return {
    baseOid,
    candidateOid,
    changedPaths,
    clean: verifiedSnapshot.clean,
    entryCount: changedPaths.length,
    headAfter,
    headBefore,
    parentCount: parentOids.length,
    parentOid,
    scope: normalizedScope,
    worktreePath: verifiedSnapshot.worktreePath,
  };
}

export const createManagedWorktree = createWorktree;

export default {
  commitWorktreeCandidate,
  createManagedWorktree,
  createWorktree,
  deriveBranchName,
  getRepoIdentity,
  resolveCommitOid,
  snapshotWorktree,
};
