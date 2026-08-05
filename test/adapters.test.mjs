import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { parseJsonlFragments, runClaude, runCodex } from '../src/adapters.mjs';
import { buildAllowedEnv, runSubprocess } from '../src/subprocess.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
const processGroupFixturePath = fileURLToPath(new URL('./fixtures/spawn-grandchild.mjs', import.meta.url));
const fakeEnvAllowlist = [
  'AGENT_SCENARIO',
  'FAKE_AGENT_CHUNK_SIZE',
  'FAKE_AGENT_EXIT_CODE',
  'FAKE_AGENT_SIZE',
  'FAKE_AGENT_SLEEP_MS',
  'FAKE_AGENT_STDERR',
  'FAKE_AGENT_STRUCTURED_RESULT',
];

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

function blockEventLoop(ms) {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, ms);
}

test('parseJsonlFragments handles chunked JSONL input', () => {
  const parsed = parseJsonlFragments([
    '{"type":"session.created","session_id":"sess-1"}\n{"type":"assistant","message":{"content":[{"text":"hel',
    'lo"}]}}\n{"type":"result","status":"success"}\n',
  ]);

  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.events[1].message.content[0].text, 'hello');
});

test('environment overrides cannot bypass the allowlist', () => {
  assert.throws(
    () => buildAllowedEnv({ UNRELATED_SECRET: 'do-not-forward' }, ['PATH']),
    /not allowlisted/,
  );
  assert.equal(
    buildAllowedEnv({ TEST_ALLOWED: 'yes' }, ['TEST_ALLOWED']).TEST_ALLOWED,
    'yes',
  );
});

test('runCodex normalizes events and stderr diagnostics', async () => {
  const result = await runCodex({
    cwd: path.dirname(fixturePath),
    env: {
      AGENT_SCENARIO: 'success',
      FAKE_AGENT_CHUNK_SIZE: '11',
      FAKE_AGENT_STDERR: 'warn one\nwarn two\n',
    },
    envAllowlist: fakeEnvAllowlist,
    executable: process.execPath,
    launcherArgs: [fixturePath],
    prompt: 'ship it',
    timeoutMs: 2_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.finalMessage, 'reply:ship it');
  assert.equal(result.nativeSessionId, 'sess-123');
  assert.equal(result.nativeThreadId, 'thread-abc');
  assert.deepEqual(result.diagnostics, ['warn one', 'warn two']);
});

test('runCodex extracts the final message from native item.completed events', async () => {
  const result = await runCodex({
    cwd: path.dirname(fixturePath),
    executable: process.execPath,
    launcherArgs: [fixturePath],
    prompt: 'native item',
    timeoutMs: 2_000,
    env: { AGENT_SCENARIO: 'codex-native' },
    envAllowlist: fakeEnvAllowlist,
  });

  assert.equal(result.ok, true);
  assert.equal(result.finalMessage, 'native reply:native item');
});

test('runClaude reports terminal failure on nonzero exit', async () => {
  const result = await runClaude({
    cwd: path.dirname(fixturePath),
    env: {
      AGENT_SCENARIO: 'failure',
      FAKE_AGENT_EXIT_CODE: '9',
    },
    envAllowlist: fakeEnvAllowlist,
    executable: process.execPath,
    launcherArgs: [fixturePath],
    prompt: 'fail please',
    timeoutMs: 2_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 9);
  assert.equal(result.terminal.status, 'failure');
  assert.match(result.terminal.message, /adapter failure/);
});

test('runClaude uses isolated print argv without disabling built-in tools', async () => {
  const result = await runClaude({
    cwd: path.dirname(fixturePath),
    env: {
      AGENT_SCENARIO: 'success',
    },
    envAllowlist: fakeEnvAllowlist,
    executable: process.execPath,
    launcherArgs: [fixturePath],
    prompt: 'ship it',
    timeoutMs: 2_000,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.args, [
    fixturePath,
    '-p',
    '--safe-mode',
    '--no-session-persistence',
    '--verbose',
    '--output-format',
    'stream-json',
    '--permission-mode',
    'acceptEdits',
  ]);
});

test('runClaude serializes an explicit built-in tool allowlist', async () => {
  const result = await runClaude({
    cwd: path.dirname(fixturePath),
    env: {
      AGENT_SCENARIO: 'success',
    },
    envAllowlist: fakeEnvAllowlist,
    executable: process.execPath,
    launcherArgs: [fixturePath],
    prompt: 'research safely',
    timeoutMs: 2_000,
    tools: ['Read', 'Grep', 'Glob', 'Read'],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.args.slice(-2), ['--tools', 'Read,Grep,Glob']);
});

test('runClaude serializes JSON schema and canonicalizes structured_output without result text', async () => {
  const jsonSchema = {
    type: 'object',
    properties: {
      schema: { const: 'team.review.v1' },
    },
    required: ['schema'],
  };
  const result = await runClaude({
    cwd: path.dirname(fixturePath),
    env: {
      AGENT_SCENARIO: 'claude-structured',
    },
    envAllowlist: fakeEnvAllowlist,
    executable: process.execPath,
    jsonSchema,
    launcherArgs: [fixturePath],
    prompt: 'return structured review JSON',
    timeoutMs: 2_000,
    tools: ['Read', 'Bash'],
  });

  assert.equal(result.ok, true);
  assert.equal(result.finalMessage, '{"schema":"team.review.v1","verdict":"APPROVED","findings":[]}');
  const schemaIndex = result.args.indexOf('--json-schema');
  assert.ok(schemaIndex >= 0);
  assert.deepEqual(JSON.parse(result.args[schemaIndex + 1]), jsonSchema);
});

test('runSubprocess enforces timeout', async () => {
  const result = await runSubprocess({
    command: process.execPath,
    args: [fixturePath],
    cwd: path.dirname(fixturePath),
    env: {
      AGENT_SCENARIO: 'sleep',
      FAKE_AGENT_SLEEP_MS: '500',
    },
    envAllowlist: fakeEnvAllowlist,
    timeoutMs: 50,
    maxStdoutBytes: 4096,
    maxStderrBytes: 4096,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.success, false);
  assert.equal(result.terminationReason, 'timeout');
});

test('runSubprocess does not count a single event-loop stall as the full timeout budget', async () => {
  const runPromise = runSubprocess({
    command: process.execPath,
    args: [fixturePath],
    cwd: path.dirname(fixturePath),
    env: {
      AGENT_SCENARIO: 'sleep',
      FAKE_AGENT_SLEEP_MS: '25',
    },
    envAllowlist: fakeEnvAllowlist,
    timeoutMs: 50,
    maxStdoutBytes: 4096,
    maxStderrBytes: 4096,
  });

  blockEventLoop(150);

  const result = await runPromise;
  assert.equal(result.success, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.terminationReason, null);
});

test('runSubprocess still times out through repeated event-loop stalls', async () => {
  const runPromise = runSubprocess({
    command: process.execPath,
    args: [fixturePath],
    cwd: path.dirname(fixturePath),
    env: {
      AGENT_SCENARIO: 'sleep',
      FAKE_AGENT_SLEEP_MS: '500',
    },
    envAllowlist: fakeEnvAllowlist,
    timeoutMs: 50,
    maxStdoutBytes: 4096,
    maxStderrBytes: 4096,
  });

  for (let iteration = 0; iteration < 8; iteration += 1) {
    blockEventLoop(30);
    await new Promise((resolve) => setImmediate(resolve));
  }

  const result = await runPromise;
  assert.equal(result.success, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminationReason, 'timeout');
});

test('runSubprocess aborts via AbortSignal and reports precedence over timeout', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 25);

  const result = await runSubprocess({
    command: process.execPath,
    args: [fixturePath],
    cwd: path.dirname(fixturePath),
    env: {
      AGENT_SCENARIO: 'sleep',
      FAKE_AGENT_SLEEP_MS: '500',
    },
    envAllowlist: fakeEnvAllowlist,
    signal: controller.signal,
    timeoutMs: 250,
    maxStdoutBytes: 4096,
    maxStderrBytes: 4096,
  });

  assert.equal(result.aborted, true);
  assert.equal(result.success, false);
  assert.equal(result.terminationReason, 'aborted');
  assert.equal(result.timedOut, false);
});

test('runSubprocess terminates the spawned process group on abort', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const root = mkdtempSync(path.join(os.tmpdir(), 'run-subprocess-tree-'));
  const pidFile = path.join(root, 'grandchild.pid');
  const controller = new AbortController();

  try {
    const runPromise = runSubprocess({
      command: process.execPath,
      args: [processGroupFixturePath],
      cwd: path.dirname(fixturePath),
      env: {
        FAKE_AGENT_PID_FILE: pidFile,
      },
      envAllowlist: [...fakeEnvAllowlist, 'FAKE_AGENT_PID_FILE'],
      killGraceMs: 0,
      signal: controller.signal,
      timeoutMs: 2_000,
    });

    const grandchildPid = await waitFor(() => {
      try {
        return Number(readFileSync(pidFile, 'utf8'));
      } catch {
        return null;
      }
    });

    controller.abort();
    const result = await runPromise;

    assert.equal(result.aborted, true);
    assert.equal(result.success, false);
    assert.equal(result.terminationReason, 'aborted');

    await waitFor(() => {
      try {
        process.kill(grandchildPid, 0);
        return false;
      } catch (error) {
        return error && error.code === 'ESRCH';
      }
    });
  } finally {
    controller.abort();
    rmSync(root, { force: true, recursive: true });
  }
});

test('runSubprocess cleans up background descendants after the direct child exits normally', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const root = mkdtempSync(path.join(os.tmpdir(), 'run-subprocess-orphan-'));
  const pidFile = path.join(root, 'grandchild.pid');

  try {
    const result = await runSubprocess({
      command: process.execPath,
      args: [processGroupFixturePath],
      cwd: path.dirname(fixturePath),
      env: {
        FAKE_AGENT_EXIT_IMMEDIATELY: '1',
        FAKE_AGENT_PID_FILE: pidFile,
      },
      envAllowlist: [...fakeEnvAllowlist, 'FAKE_AGENT_EXIT_IMMEDIATELY', 'FAKE_AGENT_PID_FILE'],
      killGraceMs: 0,
      timeoutMs: 2_000,
    });

    const grandchildPid = await waitFor(() => {
      try {
        return Number(readFileSync(pidFile, 'utf8'));
      } catch {
        return null;
      }
    });

    assert.equal(result.success, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminationReason, null);

    await waitFor(() => {
      try {
        process.kill(grandchildPid, 0);
        return false;
      } catch (error) {
        return error && error.code === 'ESRCH';
      }
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('runSubprocess enforces stdout size cap', async () => {
  const result = await runSubprocess({
    command: process.execPath,
    args: [fixturePath],
    cwd: path.dirname(fixturePath),
    env: {
      AGENT_SCENARIO: 'huge-stdout',
      FAKE_AGENT_SIZE: '16384',
    },
    envAllowlist: fakeEnvAllowlist,
    timeoutMs: 2_000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
  });

  assert.equal(result.stdoutBytes, 1024);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.success, false);
  assert.equal(result.terminationReason, 'stdout');
});

test('runSubprocess absorbs stdin EPIPE when a child exits before reading input', async () => {
  const result = await runSubprocess({
    command: process.execPath,
    args: ['-e', 'process.exit(9)'],
    cwd: path.dirname(fixturePath),
    input: 'x'.repeat(1024 * 1024),
    timeoutMs: 2_000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
  });

  assert.equal(result.exitCode, 9);
  assert.equal(result.success, false);
  if (result.stdinError) assert.match(result.stdinError.code ?? '', /EPIPE|ERR_STREAM_DESTROYED/);
});

test('runSubprocess preserves binary Buffer stdin without string coercion', async () => {
  const input = Buffer.from([0x00, 0xff, 0x41, 0x0a]);
  const result = await runSubprocess({
    command: process.execPath,
    args: ['-e', "const chunks=[];process.stdin.on('data',(chunk)=>chunks.push(chunk));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(chunks).toString('hex')));"],
    cwd: path.dirname(fixturePath),
    input,
    timeoutMs: 2_000,
  });

  assert.equal(result.success, true);
  assert.equal(result.stdout, input.toString('hex'));
});

test('adapter rejects a terminal success event when prompt delivery fails', async () => {
  const result = await runCodex({
    cwd: path.dirname(fixturePath),
    executable: process.execPath,
    launcherArgs: [
      '-e',
      'process.stdout.write(JSON.stringify({type:"turn.completed"})+"\\n"); process.exit(0)',
    ],
    prompt: 'x'.repeat(1024 * 1024),
    timeoutMs: 2_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.terminationReason, 'stdin');
  assert.equal(result.terminal.status, 'failure');
  assert.equal(result.terminal.message, 'prompt delivery failed');
});

test('runCodex normalizes abort to terminal failure', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 25);

  const result = await runCodex({
    cwd: path.dirname(fixturePath),
    env: {
      AGENT_SCENARIO: 'sleep',
      FAKE_AGENT_SLEEP_MS: '500',
    },
    envAllowlist: fakeEnvAllowlist,
    executable: process.execPath,
    launcherArgs: [fixturePath],
    prompt: 'cancel me',
    signal: controller.signal,
    timeoutMs: 250,
  });

  assert.equal(result.aborted, true);
  assert.equal(result.ok, false);
  assert.equal(result.terminal.status, 'failure');
  assert.equal(result.terminal.message, 'process aborted');
});

test('adapter refuses a zero exit without a terminal stream event', async () => {
  const result = await runCodex({
    cwd: path.dirname(fixturePath),
    env: { AGENT_SCENARIO: 'no-terminal' },
    envAllowlist: fakeEnvAllowlist,
    executable: process.execPath,
    launcherArgs: [fixturePath],
    prompt: 'unfinished',
    timeoutMs: 2_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.terminalSeen, false);
  assert.match(result.terminal.message, /without a terminal/);
});
