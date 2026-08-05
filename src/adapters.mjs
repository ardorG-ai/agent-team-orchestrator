import runSubprocess from './subprocess.mjs';

const CODEX_ENV_ALLOWLIST = ['CODEX_HOME', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY'];
const CLAUDE_ENV_ALLOWLIST = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'];

function deepSearch(value, matcher) {
  if (value === null || value === undefined) {
    return null;
  }

  if (matcher(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = deepSearch(entry, matcher);
      if (found !== null) {
        return found;
      }
    }

    return null;
  }

  if (typeof value === 'object') {
    for (const entry of Object.values(value)) {
      const found = deepSearch(entry, matcher);
      if (found !== null) {
        return found;
      }
    }
  }

  return null;
}

function pickFirstString(value, candidates) {
  for (const key of candidates) {
    const found = deepSearch(value, (entry) => (
      entry
      && typeof entry === 'object'
      && typeof entry[key] === 'string'
      && entry[key].trim() !== ''
    ));

    if (found && typeof found[key] === 'string') {
      return found[key];
    }
  }

  return null;
}

function extractText(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join('\n');
  }

  if (!value || typeof value !== 'object') {
    return '';
  }

  if (typeof value.text === 'string') {
    return value.text;
  }

  if (typeof value.message === 'string') {
    return value.message;
  }

  if (typeof value.result === 'string') {
    return value.result;
  }

  if (typeof value.content === 'string') {
    return value.content;
  }

  if (Array.isArray(value.content)) {
    return value.content.map(extractText).filter(Boolean).join('\n');
  }

  return Object.values(value)
    .map(extractText)
    .filter(Boolean)
    .join('\n');
}

function extractEventText(event) {
  if (!event || typeof event !== 'object') {
    return '';
  }

  const prioritized = [
    event.message,
    event.item,
    event.result,
    event.content,
    event.delta,
    event.response,
    event.error,
  ];

  for (const candidate of prioritized) {
    const text = extractText(candidate).trim();
    if (text) {
      return text;
    }
  }

  return '';
}

function normalizeStatus(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const lowered = value.toLowerCase();

  if (/(success|completed|complete|ok|finished)/.test(lowered)) {
    return 'success';
  }

  if (/(fail|error|denied|timeout|cancel)/.test(lowered)) {
    return 'failure';
  }

  return null;
}

export function parseJsonlFragments(fragments) {
  const inputs = Array.isArray(fragments) ? fragments : [fragments];
  let buffer = '';
  const events = [];
  const errors = [];

  const flushLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      events.push(JSON.parse(trimmed));
    } catch (error) {
      errors.push({
        line: trimmed,
        message: error.message,
      });
    }
  };

  for (const fragment of inputs) {
    buffer += String(fragment ?? '');

    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      flushLine(line);
      index = buffer.indexOf('\n');
    }
  }

  const remainder = buffer.trim();
  if (remainder) {
    try {
      events.push(JSON.parse(remainder));
      buffer = '';
    } catch (error) {
      errors.push({
        line: remainder,
        message: error.message,
      });
    }
  }

  return {
    events,
    errors,
    remainder: buffer,
  };
}

function normalizeAgentRun(adapter, subprocessResult, parsed) {
  const diagnostics = subprocessResult.stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  let finalMessage = null;
  let terminalStatus = subprocessResult.success ? 'success' : 'failure';
  let terminalMessage = diagnostics.at(-1) ?? null;
  let nativeSessionId = null;
  let nativeThreadId = null;
  let terminalSeen = false;

  for (const event of parsed.events) {
    let status = normalizeStatus(
      event.status
      ?? event.state
      ?? event.outcome
      ?? event.result_type
      ?? event.subtype
      ?? event.type
      ?? event.event
    );

    if (adapter === 'codex') {
      if (event.type === 'turn.completed') {
        status = 'success';
        terminalSeen = true;
      } else if (event.type === 'turn.failed' || event.type === 'error') {
        status = 'failure';
        terminalSeen = true;
      } else if (event.type === 'result') {
        terminalSeen = true;
      }
    } else if (adapter === 'claude' && event.type === 'result') {
      const resultStatus = normalizeStatus(event.subtype ?? event.status);
      status = event.is_error === true || resultStatus === 'failure' ? 'failure' : 'success';
      terminalSeen = true;
    } else if (event.type === 'result') {
      terminalSeen = true;
    }

    if (status) {
      terminalStatus = status;
    }

    nativeSessionId ??= pickFirstString(event, [
      'session_id',
      'native_session_id',
      'conversation_id',
      'run_id',
    ]);
    nativeThreadId ??= pickFirstString(event, [
      'thread_id',
      'native_thread_id',
      'conversation_id',
    ]);

    const maybeText = extractEventText(event);
    if (maybeText) {
      finalMessage = maybeText;
    }

    if (status === 'failure' && maybeText) {
      terminalMessage = maybeText;
    }
  }

  if (parsed.errors.length > 0) {
    diagnostics.push(...parsed.errors.map((entry) => `jsonl parse error: ${entry.message}`));
  }

  if (subprocessResult.timedOut) {
    terminalStatus = 'failure';
    terminalMessage = 'process timed out';
  }

  if (subprocessResult.aborted) {
    terminalStatus = 'failure';
    terminalMessage = 'process aborted';
  } else if (subprocessResult.terminationReason === 'stdin') {
    terminalStatus = 'failure';
    terminalMessage = 'prompt delivery failed';
  } else if (subprocessResult.terminationReason === 'stdout') {
    terminalStatus = 'failure';
    terminalMessage = 'stdout exceeded cap';
  } else if (subprocessResult.terminationReason === 'stderr') {
    terminalStatus = 'failure';
    terminalMessage = 'stderr exceeded cap';
  } else if (subprocessResult.exitCode !== 0 && !terminalMessage) {
    terminalMessage = `process exited with code ${subprocessResult.exitCode}`;
  } else if (!terminalSeen) {
    terminalStatus = 'failure';
    terminalMessage = 'adapter exited without a terminal stream event';
  }

  if (!finalMessage && terminalMessage) {
    finalMessage = terminalMessage;
  }

  const ok = terminalStatus === 'success' && subprocessResult.success;

  return {
    adapter,
    args: subprocessResult.args,
    aborted: subprocessResult.aborted,
    command: subprocessResult.command,
    cwd: subprocessResult.cwd,
    diagnostics,
    events: parsed.events,
    exitCode: subprocessResult.exitCode,
    finalMessage,
    nativeSessionId,
    nativeThreadId,
    ok,
    signal: subprocessResult.signal,
    stderr: subprocessResult.stderr,
    stdinError: subprocessResult.stdinError,
    stdout: subprocessResult.stdout,
    terminal: {
      message: terminalMessage,
      status: terminalStatus,
    },
    timedOut: subprocessResult.timedOut,
    terminationReason: subprocessResult.terminationReason,
    terminalSeen,
  };
}

async function runAdapter(adapter, options, buildArgs, providerEnvAllowlist) {
  const {
    cwd,
    env = {},
    envAllowlist = [],
    executable = adapter,
    launcherArgs = [],
    maxStderrBytes,
    maxStdoutBytes,
    prompt,
    signal,
    timeoutMs,
  } = options ?? {};

  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new TypeError(`${adapter} adapter requires a non-empty prompt`);
  }

  const subprocessResult = await runSubprocess({
    args: [...launcherArgs, ...buildArgs(cwd)],
    command: executable,
    cwd,
    env,
    envAllowlist: [...providerEnvAllowlist, ...envAllowlist],
    input: prompt,
    maxStderrBytes,
    maxStdoutBytes,
    signal,
    timeoutMs,
  });

  const parsed = parseJsonlFragments(subprocessResult.stdout);
  return normalizeAgentRun(adapter, subprocessResult, parsed);
}

export async function runCodex(options) {
  return runAdapter('codex', options, (cwd) => ['exec', '--json', '--sandbox', 'workspace-write', '-C', cwd, '-'], CODEX_ENV_ALLOWLIST);
}

export async function runClaude(options) {
  return runAdapter('claude', options, () => ['-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'acceptEdits'], CLAUDE_ENV_ALLOWLIST);
}

export const runCodexAdapter = runCodex;
export const runClaudeAdapter = runClaude;

export default {
  parseJsonlFragments,
  runClaude,
  runClaudeAdapter,
  runCodex,
  runCodexAdapter,
};
