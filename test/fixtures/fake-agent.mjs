#!/usr/bin/env node

import process from 'node:process';

const scenario = process.env.AGENT_SCENARIO ?? 'success';
const stdin = await new Promise((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  process.stdin.on('end', () => resolve(data));
});

function emitJsonLines(lines, chunkSize = 0) {
  const payload = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  if (chunkSize > 0) {
    for (let index = 0; index < payload.length; index += chunkSize) {
      process.stdout.write(payload.slice(index, index + chunkSize));
    }
    return;
  }

  process.stdout.write(payload);
}

if (process.env.FAKE_AGENT_STDERR) {
  process.stderr.write(process.env.FAKE_AGENT_STDERR);
}

switch (scenario) {
  case 'success':
    emitJsonLines([
      { type: 'session.created', session_id: 'sess-123' },
      { type: 'thread.created', thread_id: 'thread-abc' },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'output_text', text: `reply:${stdin.trim()}` }],
        },
      },
      { type: 'result', status: 'success' },
    ], Number(process.env.FAKE_AGENT_CHUNK_SIZE || 0));
    break;
  case 'failure':
    emitJsonLines([
      { type: 'session.created', session_id: 'sess-123' },
      { type: 'result', status: 'failure', message: 'adapter failure' },
    ]);
    process.exitCode = Number(process.env.FAKE_AGENT_EXIT_CODE || 17);
    break;
  case 'huge-stdout':
    process.stdout.write('x'.repeat(Number(process.env.FAKE_AGENT_SIZE || 8192)));
    break;
  case 'sleep':
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_AGENT_SLEEP_MS || 500)));
    emitJsonLines([{ type: 'result', status: 'success' }]);
    break;
  case 'no-terminal':
    emitJsonLines([{ type: 'assistant', message: { content: [{ text: 'partial only' }] } }]);
    break;
  case 'codex-native':
    emitJsonLines([
      { type: 'thread.started', thread_id: 'thread-native' },
      { type: 'item.completed', item: { type: 'agent_message', text: `native reply:${stdin.trim()}` } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    break;
  case 'claude-structured': {
    const result = process.env.FAKE_AGENT_STRUCTURED_RESULT
      ?? '{"schema":"team.review.v1","verdict":"APPROVED","findings":[]}';
    emitJsonLines([{
      type: 'result',
      subtype: 'success',
      is_error: false,
      structured_output: JSON.parse(result),
    }]);
    break;
  }
  default:
    emitJsonLines([{ type: 'result', status: 'failure', message: `unknown scenario:${scenario}` }]);
    process.exitCode = 1;
}
