#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const prompt = await new Promise((resolve) => {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => resolve(input));
});

const outputPath = path.join(process.cwd(), 'agent-output.txt');
writeFileSync(outputPath, `committed by fake agent\nprompt-bytes=${Buffer.byteLength(prompt)}\n`, 'utf8');
execFileSync('git', ['add', 'agent-output.txt'], { cwd: process.cwd(), shell: false });
execFileSync('git', ['commit', '-m', 'Create the fixture candidate'], {
  cwd: process.cwd(),
  shell: false,
  stdio: ['ignore', 'ignore', 'pipe'],
});

for (const event of [
  { type: 'thread.started', thread_id: 'thread-e2e' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'fixture committed' } },
  { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
]) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
