import fs from 'node:fs/promises';
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

async function runGit(args, cwd) {
  const result = await runSubprocess({
    command: 'git',
    args: ['-C', cwd, ...args],
    cwd,
    maxStdoutBytes: 512 * 1024,
    maxStderrBytes: 512 * 1024,
    timeoutMs: 20_000,
  });

  if (!result.success) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git exited with code ${result.exitCode}`;
    const error = new Error(detail);
    error.result = result;
    throw error;
  }

  return result.stdout.trim();
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

  await runGit(['worktree', 'add', '-b', branchName, worktreePath, baseOid], realRepoPath);

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

  const status = await runGit(['status', '--porcelain'], worktreePath);
  if (status !== '') {
    throw new Error('snapshot requires a clean worktree');
  }

  return {
    candidateOid: await resolveCommitOid(worktreePath, 'HEAD'),
    clean: true,
    worktreePath: await fs.realpath(worktreePath),
  };
}

export const createManagedWorktree = createWorktree;

export default {
  createManagedWorktree,
  createWorktree,
  deriveBranchName,
  getRepoIdentity,
  resolveCommitOid,
  snapshotWorktree,
};
