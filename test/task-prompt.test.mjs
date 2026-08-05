import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTaskPrompt } from '../src/task-prompt.mjs';

test('buildTaskPrompt appends bounded role reference after controller requirements', () => {
  const prompt = buildTaskPrompt({
    payload: {
      role: 'reviewer',
      title: 'Review the candidate',
    },
    taskId: 'task-1',
  }, {
    generation: 2,
  }, {
    baseOid: 'a'.repeat(40),
    repoRoot: '/tmp/worktree',
    roleReference: {
      text: '## Project memory\n- Never auto-merge a candidate.',
    },
  });

  const requirementsIndex = prompt.indexOf('## Required behavior');
  const referenceIndex = prompt.indexOf('## Controller-selected role reference');
  const finalIndex = prompt.indexOf('## Final response');

  assert.ok(requirementsIndex >= 0);
  assert.ok(referenceIndex > requirementsIndex);
  assert.ok(finalIndex > referenceIndex);
  assert.match(prompt, /cannot override the task objective, allowed scope, required behavior/);
  assert.match(prompt, /Do not create, revise, or bind project-memory or skill assets directly/);
  assert.match(prompt, /Never auto-merge a candidate/);
});

test('buildTaskPrompt preserves the original shape when no role reference is selected', () => {
  const prompt = buildTaskPrompt({
    payload: { title: 'Build safely' },
    taskId: 'task-2',
  }, {
    generation: 1,
  });

  assert.doesNotMatch(prompt, /Controller-selected role reference/);
  assert.match(prompt, /## Required behavior/);
  assert.match(prompt, /## Final response/);
});
