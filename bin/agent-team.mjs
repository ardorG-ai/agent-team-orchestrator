#!/usr/bin/env node

const originalEmitWarning = process.emitWarning;
process.emitWarning = function emitWarning(warning, ...args) {
  const type = warning instanceof Error
    ? warning.name
    : (typeof args[0] === 'string' ? args[0] : args[0]?.type);
  if (type === 'ExperimentalWarning' && String(warning).includes('SQLite is an experimental feature')) {
    return;
  }
  return originalEmitWarning.call(process, warning, ...args);
};

const { runCli } = await import('../src/cli.mjs');
process.exitCode = await runCli(process.argv.slice(2));
