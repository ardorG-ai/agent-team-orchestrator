import test from 'node:test';
import assert from 'node:assert/strict';
import { booleanFlag, integerFlag, listFlag, parseArgv, requiredFlag } from '../src/argv.mjs';

test('parseArgv separates positionals, repeated flags, and equals syntax', () => {
  const parsed = parseArgv(['task', 'add', '--scope', 'src', '--scope=test,docs', '--json']);
  assert.deepEqual(parsed.positionals, ['task', 'add']);
  assert.deepEqual(listFlag(parsed, 'scope'), ['src', 'test', 'docs']);
  assert.equal(booleanFlag(parsed, 'json'), true);
});

test('typed flag helpers reject malformed values', () => {
  const parsed = parseArgv(['--lease-ms', '30000', '--enabled=false']);
  assert.equal(integerFlag(parsed, 'lease-ms', 1, { min: 1 }), 30000);
  assert.equal(booleanFlag(parsed, 'enabled'), false);
  assert.throws(() => requiredFlag(parsed, 'missing'), { code: 'missing_argument' });
});
