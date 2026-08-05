import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolveExecutable } from './subprocess.mjs';

function commandVersion(command, args = ['--version']) {
  let executable;
  try {
    executable = resolveExecutable(command);
  } catch (error) {
    return { ok: false, path: null, version: null, error: error.message };
  }
  const result = spawnSync(executable, args, { encoding: 'utf8', shell: false });
  return {
    ok: result.status === 0,
    path: executable,
    version: result.status === 0 ? (result.stdout || result.stderr).trim().split('\n')[0] : null,
    error: result.status === 0 ? null : (result.stderr || result.error?.message || 'not available').trim(),
  };
}

export async function runDoctor(context, store = undefined) {
  let sqlite = { ok: false, error: 'node:sqlite unavailable' };
  try {
    const module = await import('node:sqlite');
    sqlite = { ok: typeof module.DatabaseSync === 'function' };
  } catch (error) {
    sqlite = { ok: false, error: error.message };
  }

  let key = { ok: false, error: 'event key missing' };
  if (existsSync(context.keyPath)) {
    const mode = statSync(context.keyPath).mode & 0o777;
    try {
      accessSync(context.keyPath, constants.R_OK);
      key = { ok: mode === 0o600, mode: mode.toString(8), error: mode === 0o600 ? null : 'expected mode 600' };
    } catch (error) {
      key = { ok: false, mode: mode.toString(8), error: error.message };
    }
  }

  let database = { ok: existsSync(context.dbPath), integrity: null };
  if (store) {
    try {
      database = { ok: true, integrity: store.integrityCheck?.() ?? 'ok' };
    } catch (error) {
      database = { ok: false, integrity: null, error: error.message };
    }
  }

  const checks = {
    node: { ok: Number(process.versions.node.split('.')[0]) >= 22, version: process.versions.node },
    sqlite,
    git: commandVersion('git'),
    codex: commandVersion('codex'),
    claude: commandVersion('claude'),
    repository: { ok: Boolean(context.repoRoot), path: context.repoRoot, id: context.repoId },
    eventKey: key,
    database,
  };
  return { ok: Object.values(checks).every((check) => check.ok), checks };
}
