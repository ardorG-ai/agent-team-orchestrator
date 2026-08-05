import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_ENV_ALLOWLIST = Object.freeze([
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'SHELL',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
]);

function appendWithinCap(state, chunk, limit) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const available = Math.max(limit - state.size, 0);

  if (available > 0) {
    state.chunks.push(buffer.subarray(0, available));
    state.size += Math.min(buffer.length, available);
  }

  return buffer.length > available;
}

function normalizeAllowlist(allowlist) {
  if (!Array.isArray(allowlist)) {
    return [...DEFAULT_ENV_ALLOWLIST];
  }

  return [...new Set([...DEFAULT_ENV_ALLOWLIST, ...allowlist])];
}

export function buildAllowedEnv(overrides = {}, allowlist = DEFAULT_ENV_ALLOWLIST) {
  const env = {};
  const normalizedAllowlist = normalizeAllowlist(allowlist);
  const allowedKeys = new Set(normalizedAllowlist);

  for (const key of normalizedAllowlist) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }

  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`environment override is not allowlisted: ${key}`);
    }
    if (value === undefined || value === null) {
      delete env[key];
      continue;
    }

    env[key] = String(value);
  }

  return env;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hasPosixProcessGroup(groupId) {
  if (!groupId || process.platform === 'win32') {
    return false;
  }

  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

function sendPosixGroupSignal(groupId, signal) {
  if (!groupId) {
    return false;
  }

  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

async function waitForPosixProcessGroupExit(groupId, timeoutMs) {
  const deadline = Date.now() + Math.max(timeoutMs, 0);
  while (hasPosixProcessGroup(groupId)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(10);
  }
  return true;
}

function resolveTaskkillExecutable() {
  if (process.env.SYSTEMROOT) {
    return path.join(process.env.SYSTEMROOT, 'System32', 'taskkill.exe');
  }

  return 'taskkill';
}

async function runTaskkill(pid, force = false) {
  if (!pid || process.platform !== 'win32') {
    return false;
  }

  const args = ['/PID', String(pid), '/T'];
  if (force) {
    args.push('/F');
  }

  return await new Promise((resolve) => {
    const child = spawn(resolveTaskkillExecutable(), args, {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });

    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}

async function terminateProcessTree(child, signal, graceMs) {
  if (!child.pid) {
    return;
  }

  if (process.platform === 'win32') {
    const firstPass = await runTaskkill(child.pid, false);
    if (graceMs > 0 && firstPass) {
      await delay(graceMs);
    }
    await runTaskkill(child.pid, true);
    return;
  }

  const groupId = child.pid;
  if (!hasPosixProcessGroup(groupId)) {
    return;
  }

  sendPosixGroupSignal(groupId, signal);
  if (graceMs <= 0 || signal === 'SIGKILL') {
    sendPosixGroupSignal(groupId, 'SIGKILL');
    await waitForPosixProcessGroupExit(groupId, 250);
    return;
  }

  const exitedDuringGrace = await waitForPosixProcessGroupExit(groupId, graceMs);
  if (exitedDuringGrace) {
    return;
  }

  sendPosixGroupSignal(groupId, 'SIGKILL');
  await waitForPosixProcessGroupExit(groupId, 250);
}

export function resolveExecutable(command, env = process.env) {
  if (path.isAbsolute(command)) {
    accessSync(command, constants.X_OK);
    if (!statSync(command).isFile()) throw new TypeError(`executable is not a file: ${command}`);
    return command;
  }

  for (const directory of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new TypeError(`executable not found on PATH: ${command}`);
}

export async function runSubprocess(options) {
  const {
    command,
    args = [],
    cwd,
    input = '',
    timeoutMs = 0,
    maxStdoutBytes = 1024 * 1024,
    maxStderrBytes = 1024 * 1024,
    env = {},
    envAllowlist = DEFAULT_ENV_ALLOWLIST,
    killSignal = 'SIGTERM',
    killGraceMs = 250,
    signal,
  } = options ?? {};

  if (!command || typeof command !== 'string') {
    throw new TypeError('runSubprocess requires a command string');
  }

  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new TypeError('runSubprocess args must be an array of strings');
  }

  if (!Number.isFinite(maxStdoutBytes) || maxStdoutBytes < 0) {
    throw new TypeError('maxStdoutBytes must be a non-negative number');
  }

  if (!Number.isFinite(maxStderrBytes) || maxStderrBytes < 0) {
    throw new TypeError('maxStderrBytes must be a non-negative number');
  }

  const stdoutState = { chunks: [], size: 0 };
  const stderrState = { chunks: [], size: 0 };
  let timedOut = false;
  let aborted = false;
  let outputLimit = null;
  let spawnError = null;
  let stdinError = null;
  let settled = false;
  let treeTerminationPromise = null;
  const inputBuffer = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input === null || input === undefined ? '' : String(input));
  const inputBytes = inputBuffer.length;

  const startedAt = Date.now();
  const allowedEnv = buildAllowedEnv(env, envAllowlist);
  const executable = resolveExecutable(command, allowedEnv);
  const child = spawn(executable, args, {
    cwd,
    detached: process.platform !== 'win32',
    env: allowedEnv,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const ensureProcessTreeTerminated = () => {
    if (!treeTerminationPromise) {
      treeTerminationPromise = terminateProcessTree(child, killSignal, killGraceMs);
    }
    return treeTerminationPromise;
  };

  const abortHandler = () => {
    aborted = true;
    void ensureProcessTreeTerminated();
  };

  if (signal?.aborted) {
    abortHandler();
  } else if (signal) {
    signal.addEventListener('abort', abortHandler, { once: true });
  }

  const timeoutId = timeoutMs > 0
    ? setTimeout(() => {
        if (aborted) {
          return;
        }
        timedOut = true;
        void ensureProcessTreeTerminated();
      }, timeoutMs)
    : null;

  const result = await new Promise((resolve, reject) => {
    child.once('error', (error) => {
      spawnError = error;
    });

    child.stdout.on('data', (chunk) => {
      if (!outputLimit && appendWithinCap(stdoutState, chunk, maxStdoutBytes)) {
        outputLimit = 'stdout';
        void ensureProcessTreeTerminated();
      }
    });

    child.stderr.on('data', (chunk) => {
      if (!outputLimit && appendWithinCap(stderrState, chunk, maxStderrBytes)) {
        outputLimit = 'stderr';
        void ensureProcessTreeTerminated();
      }
    });

    child.stdin.on('error', (error) => {
      stdinError = error;
    });

    child.once('close', (exitCode, signal) => {
      settled = true;
      resolve({ exitCode, signal });
    });

    child.once('error', (error) => {
      if (!settled) {
        reject(error);
      }
    });

    child.stdin.end(inputBuffer);
  }).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (signal) {
      signal.removeEventListener('abort', abortHandler);
    }
  });

  if (
    process.platform !== 'win32'
    && !aborted
    && !timedOut
    && !outputLimit
    && !treeTerminationPromise
    && hasPosixProcessGroup(child.pid)
  ) {
    treeTerminationPromise = terminateProcessTree(child, killSignal, killGraceMs);
  }

  if (treeTerminationPromise) {
    await treeTerminationPromise;
  }

  if (spawnError && result.exitCode === null && result.signal === null) {
    throw spawnError;
  }

  const stdout = Buffer.concat(stdoutState.chunks).toString('utf8');
  const stderr = Buffer.concat(stderrState.chunks).toString('utf8');
  const durationMs = Date.now() - startedAt;
  const stdinFailed = inputBytes > 0 && stdinError !== null;
  const success = !aborted
    && !timedOut
    && !outputLimit
    && !stdinFailed
    && result.exitCode === 0;
  const terminationReason = aborted
    ? 'aborted'
    : (timedOut ? 'timeout' : (outputLimit ?? (stdinFailed ? 'stdin' : null)));

  return {
    aborted,
    command: executable,
    args: [...args],
    cwd: cwd ?? process.cwd(),
    durationMs,
    envKeys: Object.keys(allowedEnv).sort(),
    exitCode: result.exitCode,
    signal: result.signal,
    stderr,
    stderrBytes: stderrState.size,
    stderrTruncated: outputLimit === 'stderr',
    stdinError: stdinError
      ? { code: stdinError.code ?? null, message: stdinError.message }
      : null,
    stdout,
    stdoutBytes: stdoutState.size,
    stdoutTruncated: outputLimit === 'stdout',
    success,
    timedOut,
    terminationReason,
  };
}

export default runSubprocess;
