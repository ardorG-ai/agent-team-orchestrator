#!/usr/bin/env node

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
writeFileSync(outputPath, `edited by fake agent\nprompt-bytes=${Buffer.byteLength(prompt)}\n`, 'utf8');

for (const event of [
  { type: 'thread.started', thread_id: 'thread-e2e' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'fixture edited the allowed file' } },
  { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
]) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
