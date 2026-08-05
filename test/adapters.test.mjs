import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJsonlFragments, runClaude, runCodex } from '../src/adapters.mjs';
import { buildAllowedEnv, runSubprocess } from '../src/subprocess.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
const fakeEnvAllowlist = [
  'AGENT_SCENARIO',
  'FAKE_AGENT_CHUNK_SIZE',
  'FAKE_AGENT_EXIT_CODE',
  'FAKE_AGENT_SIZE',
  'FAKE_AGENT_SLEEP_MS',
  'FAKE_AGENT_STDERR',
];

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
