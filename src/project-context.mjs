import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { execFileSync } from 'node:child_process';
import { AgentTeamError, invariant } from './errors.mjs';
import { resolveExecutable } from './subprocess.mjs';

let gitExecutable;

function resolvedGitExecutable() {
  gitExecutable ??= resolveExecutable('git');
  return gitExecutable;
}

function git(args, cwd) {
  try {
    return execFileSync(resolvedGitExecutable(), ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString?.().trim();
    throw new AgentTeamError('git_command_failed', stderr || `git ${args.join(' ')} failed`, { args, cwd });
  }
}

export function ensureGitRepository(inputPath = process.cwd()) {
  const requested = resolve(inputPath);
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  try {
    return realpathSync(git(['rev-parse', '--show-toplevel'], requested));
  } catch (error) {
    if (!(error instanceof AgentTeamError)) throw error;
    execFileSync(resolvedGitExecutable(), ['init', '-b', 'main', requested], { stdio: 'pipe', shell: false });
    return realpathSync(requested);
  }
}

export function resolveRepository(inputPath = process.cwd()) {
  const requested = realpathSync(resolve(inputPath));
  const root = realpathSync(git(['rev-parse', '--show-toplevel'], requested));
  const commonRaw = git(['rev-parse', '--git-common-dir'], root);
  const commonDir = realpathSync(isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw));
  const repoId = createHash('sha256').update(`${root}\0${commonDir}`).digest('hex').slice(0, 24);
  return { repoRoot: root, gitCommonDir: commonDir, repoId };
}

export function defaultStateRoot(env = process.env) {
  if (env.AGENT_TEAM_STATE_ROOT) return resolve(env.AGENT_TEAM_STATE_ROOT);
  if (env.XDG_STATE_HOME) return resolve(env.XDG_STATE_HOME, 'agent-team-orchestrator');
  return join(homedir(), '.local', 'state', 'agent-team-orchestrator');
}

function ensurePrivateDirectory(path) {
  if (existsSync(path)) {
    const stats = lstatSync(path);
    invariant(!stats.isSymbolicLink(), 'unsafe_state_path', `state directory must not be a symlink: ${path}`);
    invariant(stats.isDirectory(), 'unsafe_state_path', `state path must be a directory: ${path}`);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return realpathSync(path);
}

function ensureStateContainer(path) {
  if (existsSync(path)) {
    const stats = lstatSync(path);
    invariant(!stats.isSymbolicLink(), 'unsafe_state_path', `state root must not be a symlink: ${path}`);
    invariant(stats.isDirectory(), 'unsafe_state_path', `state root must be a directory: ${path}`);
    return realpathSync(path);
  }

  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return realpathSync(path);
}

function isInside(parent, child) {
  const candidate = relative(resolve(parent), resolve(child));
  return candidate === ''
    || (candidate !== '..' && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate));
}

function ensureEventKey(path) {
  ensurePrivateDirectory(dirname(path));
  if (!existsSync(path)) {
    const flags = constants.O_WRONLY
      | constants.O_CREAT
      | constants.O_EXCL
      | (constants.O_NOFOLLOW ?? 0);
    const fd = openSync(path, flags, 0o600);
    try {
      writeFileSync(fd, randomBytes(32).toString('hex'), { encoding: 'utf8' });
    } finally {
      closeSync(fd);
    }
  } else {
    const stats = lstatSync(path);
    invariant(!stats.isSymbolicLink(), 'unsafe_event_key', 'event signing key must not be a symlink');
    invariant(stats.isFile(), 'unsafe_event_key', 'event signing key must be a regular file');
  }
  chmodSync(path, 0o600);
  const encoded = readFileSync(path, 'utf8').trim();
  invariant(/^[a-f0-9]{64}$/.test(encoded), 'invalid_event_key', 'event signing key must be 32-byte hex');
}

export function projectContext(repoPath = process.cwd(), options = {}) {
  const repository = resolveRepository(repoPath);
  const requestedStateRoot = resolve(options.stateRoot ?? defaultStateRoot(options.env));
  const repositoryAuthorityRoot = dirname(repository.gitCommonDir);
  invariant(
    !isInside(repository.repoRoot, requestedStateRoot)
      && !isInside(repositoryAuthorityRoot, requestedStateRoot),
    'unsafe_state_path',
    'state root must live outside the repository',
    { repoRoot: repository.repoRoot, stateRoot: requestedStateRoot },
  );

  const stateRoot = ensureStateContainer(requestedStateRoot);
  invariant(
    !isInside(repository.repoRoot, stateRoot)
      && !isInside(repositoryAuthorityRoot, stateRoot),
    'unsafe_state_path',
    'resolved state root must live outside the repository',
    { repoRoot: repository.repoRoot, stateRoot },
  );
  const projectsRoot = ensurePrivateDirectory(join(stateRoot, 'projects'));
  const projectDir = ensurePrivateDirectory(join(projectsRoot, repository.repoId));
  const worktreeRoot = ensurePrivateDirectory(join(projectDir, 'worktrees'));
  const artifactRoot = ensurePrivateDirectory(join(projectDir, 'artifacts'));
  const secretsRoot = ensurePrivateDirectory(join(projectDir, 'secrets'));
  const keyPath = join(secretsRoot, 'events.key');
  ensureEventKey(keyPath);
  const dbPath = join(projectDir, 'control.sqlite');
  return { ...repository, stateRoot, projectDir, worktreeRoot, artifactRoot, keyPath, dbPath };
}
