#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const pidFile = process.env.FAKE_AGENT_PID_FILE;
const shouldExitImmediately = process.env.FAKE_AGENT_EXIT_IMMEDIATELY === '1';

if (!pidFile) {
  throw new Error('FAKE_AGENT_PID_FILE is required');
}

const grandchild = spawn(
  process.execPath,
  ['-e', 'setInterval(() => {}, 1_000);'],
  {
    detached: false,
    stdio: 'ignore',
  },
);

await writeFile(pidFile, `${grandchild.pid}`);

if (shouldExitImmediately) {
  process.exit(0);
}

setInterval(() => {}, 1_000);
