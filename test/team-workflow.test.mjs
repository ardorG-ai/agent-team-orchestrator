import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TEAM_HANDOFF_MAX_BYTES,
  aggregateTeamChildren,
  buildTeamChildren,
  buildTeamHandoff,
  parseTeamPlan,
  parseTeamReview,
  parseTeamVerification,
} from '../src/team-workflow.mjs';

function validPlan(overrides = {}) {
  return {
    schema: 'team.plan.v1',
    summary: 'Deliver the requested feature through independent implementation and checks.',
    assumptions: ['The existing public API remains compatible.'],
    acceptanceCriteria: [
      { id: 'ac-1', text: 'The requested behavior is implemented.' },
      { id: 'ac-2', text: 'Relevant tests and static checks pass.' },
    ],
    lanes: {
      builder: {
        objective: 'Implement the requested behavior and leave scoped edits for controller publication.',
        scope: ['src/', 'test/'],
      },
      researcher: {
        objective: 'Inspect relevant references and report constraints.',
        scope: [],
      },
      test: {
        objective: 'Exercise the candidate requirements and report gaps.',
        scope: ['test/'],
      },
    },
    requiredChecks: ['npm test', 'npm run check'],
    ...overrides,
  };
}

function completedChild(sliceKey, overrides = {}) {
  return {
    taskId: `task-${sliceKey}`,
    parentTaskId: 'parent-1',
    sliceKey,
    state: 'completed',
    payload: {
      adapter: sliceKey === 'researcher' || sliceKey === 'reviewer' ? 'claude' : 'codex',
      role: sliceKey,
    },
    result: {
      adapter: sliceKey === 'researcher' || sliceKey === 'reviewer' ? 'claude' : 'codex',
      baseOid: 'a'.repeat(40),
      candidateOid: sliceKey === 'builder' ? 'b'.repeat(40) : 'a'.repeat(40),
      finalMessage: `${sliceKey} finished`,
      ...overrides.result,
    },
    ...overrides,
  };
}

test('parseTeamPlan accepts the fixed three-lane schema and rejects unknown structure', () => {
  const parsed = parseTeamPlan(JSON.stringify(validPlan()));

  assert.equal(parsed.schema, 'team.plan.v1');
  assert.deepEqual(Object.keys(parsed.lanes), ['builder', 'researcher', 'test']);
  assert.equal(parsed.acceptanceCriteria.length, 2);

  assert.throws(
    () => parseTeamPlan(JSON.stringify(validPlan({ extra: true }))),
    /unknown key/i,
  );
  assert.throws(
    () => parseTeamPlan(JSON.stringify(validPlan({
      lanes: {
        ...validPlan().lanes,
        deployer: { objective: 'Ship it', scope: [] },
      },
    }))),
    /lanes.*unknown key/i,
  );
  assert.throws(
    () => parseTeamPlan(JSON.stringify(validPlan({
      acceptanceCriteria: [
        { id: 'duplicate', text: 'First' },
        { id: 'duplicate', text: 'Second' },
      ],
    }))),
    /unique/i,
  );
  assert.throws(
    () => parseTeamPlan(JSON.stringify(validPlan({ summary: 'x'.repeat(5_000) }))),
    /summary.*bytes/i,
  );
  assert.throws(
    () => parseTeamPlan(JSON.stringify(validPlan({ requiredChecks: [] }))),
    /requiredChecks.*at least 1/i,
  );
  assert.throws(() => parseTeamPlan('```json\n{}\n```'), /valid JSON/i);
});

test('buildTeamChildren emits the fixed dependency graph and bounded adapter overrides', () => {
  let sequence = 0;
  const children = buildTeamChildren({
    baseOid: 'a'.repeat(40),
    generateTaskId: () => `child-${++sequence}`,
    parentTask: {
      key: 'feature/root',
      payload: {
        teamAdapters: {
          builder: 'claude',
          reviewer: 'codex',
        },
        title: 'Ship the feature',
      },
      taskId: 'parent-1',
    },
    plan: validPlan(),
  });

  assert.deepEqual(children.map((child) => child.sliceKey), [
    'builder',
    'researcher',
    'test',
    'reviewer',
    'verifier',
  ]);
  assert.deepEqual(children.map((child) => child.key), [
    'feature/root::builder',
    'feature/root::researcher',
    'feature/root::test',
    'feature/root::reviewer',
    'feature/root::verifier',
  ]);
  assert.deepEqual(children.map((child) => child.payload.adapter), [
    'claude',
    'claude',
    'codex',
    'codex',
    'codex',
  ]);
  assert.deepEqual(children[0].dependencySliceKeys, []);
  assert.deepEqual(children[1].dependencySliceKeys, []);
  assert.deepEqual(children[2].dependencySliceKeys, []);
  assert.deepEqual(children[3].dependencySliceKeys, ['builder', 'researcher', 'test']);
  assert.deepEqual(children[4].dependencySliceKeys, ['reviewer']);
  assert.equal(children[3].payload.baseFromTaskId, 'child-1');
  assert.equal(children[4].payload.baseFromTaskId, 'child-1');
  assert.deepEqual(children[3].payload.handoffTaskIds, ['child-1', 'child-2', 'child-3']);
  assert.deepEqual(children[4].payload.handoffTaskIds, ['child-1', 'child-4']);
  assert.deepEqual(children.map((child) => child.payload.executionMode), [
    'build',
    'report',
    'report',
    'review',
    'verify',
  ]);

  assert.throws(
    () => buildTeamChildren({
      baseOid: 'a'.repeat(40),
      parentTask: {
        key: 'feature/root',
        payload: { teamAdapters: { deployer: 'codex' } },
        taskId: 'parent-1',
      },
      plan: validPlan(),
    }),
    /teamAdapters.*unknown key/i,
  );
  assert.throws(
    () => buildTeamChildren({
      baseOid: 'a'.repeat(40),
      parentTask: {
        key: 'feature/root',
        payload: { teamAdapters: { builder: 'gemini' } },
        taskId: 'parent-1',
      },
      plan: validPlan(),
    }),
    /codex.*claude/i,
  );
});

test('buildTeamChildren prevents planner scopes from escaping operator scope', () => {
  const parentTask = {
    key: 'feature/scoped',
    payload: {
      scope: ['src/runtime/', 'test/runtime/'],
      title: 'Scoped change',
    },
    taskId: 'parent-1',
  };
  const scopedPlan = validPlan({
    lanes: {
      builder: { objective: 'Build safely', scope: ['src/runtime/team.mjs'] },
      researcher: { objective: 'Research safely', scope: [] },
      test: { objective: 'Test safely', scope: ['test/runtime/team.test.mjs'] },
    },
  });

  const children = buildTeamChildren({
    baseOid: 'a'.repeat(40),
    generateTaskId: (() => {
      let value = 0;
      return () => `scoped-${++value}`;
    })(),
    parentTask,
    plan: scopedPlan,
  });
  assert.deepEqual(children[1].payload.scope, ['src/runtime', 'test/runtime']);
  assert.deepEqual(children[3].payload.scope, ['src/runtime', 'test/runtime']);
  assert.deepEqual(children[4].payload.scope, ['src/runtime', 'test/runtime']);

  assert.throws(
    () => buildTeamChildren({
      baseOid: 'a'.repeat(40),
      parentTask,
      plan: validPlan({
        lanes: {
          ...scopedPlan.lanes,
          builder: { objective: 'Escape scope', scope: ['src/other.mjs'] },
        },
      }),
    }),
    /outside parentTask\.payload\.scope/i,
  );
  assert.throws(
    () => buildTeamChildren({
      baseOid: 'a'.repeat(40),
      parentTask: { ...parentTask, payload: { scope: [] } },
      plan: validPlan({
        lanes: {
          ...scopedPlan.lanes,
          builder: { objective: 'Escape worktree', scope: ['../secrets'] },
        },
      }),
    }),
    /relative.*\.\./i,
  );
  assert.throws(
    () => buildTeamChildren({
      baseOid: 'a'.repeat(40),
      parentTask: { ...parentTask, payload: { scope: [] } },
      plan: validPlan({
        lanes: {
          ...scopedPlan.lanes,
          builder: { objective: 'Absolute escape', scope: ['/tmp/escape'] },
        },
      }),
    }),
    /relative/i,
  );
});

test('review and verification contracts fail closed on unknown fields and missing proof', () => {
  const review = parseTeamReview(JSON.stringify({
    schema: 'team.review.v1',
    verdict: 'CHANGES_REQUESTED',
    findings: [{
      severity: 'HIGH',
      text: 'The retry path can publish twice.',
      proof: 'test/retry.test.mjs reproduces the duplicate message.',
    }],
  }));
  assert.equal(review.findings[0].severity, 'HIGH');

  assert.throws(
    () => parseTeamReview(JSON.stringify({
      schema: 'team.review.v1',
      verdict: 'CHANGES_REQUESTED',
      findings: [{ severity: 'CRITICAL', text: 'Unsafe mutation', proof: '' }],
    })),
    /proof/i,
  );
  assert.throws(
    () => parseTeamReview(JSON.stringify({
      schema: 'team.review.v1',
      verdict: 'APPROVED',
      findings: [],
      commentary: 'looks good',
    })),
    /unknown key/i,
  );

  const verification = parseTeamVerification(JSON.stringify({
    schema: 'team.verify.v1',
    verdict: 'PASS',
    summary: 'All required checks passed.',
    checks: [{ name: 'npm test', status: 'PASS', evidence: '82 tests passed.' }],
  }));
  assert.equal(verification.verdict, 'PASS');
  assert.throws(
    () => parseTeamVerification(JSON.stringify({
      schema: 'team.verify.v1',
      verdict: 'PASS',
      summary: 'Contradictory result.',
      checks: [{ name: 'npm test', status: 'FAIL', evidence: 'one failure' }],
    })),
    /PASS.*failed check/i,
  );
  assert.throws(
    () => parseTeamVerification(JSON.stringify({
      schema: 'team.verify.v1',
      verdict: 'PASS',
      summary: 'No checks were actually run.',
      checks: [],
    })),
    /at least 1/i,
  );
});

test('buildTeamHandoff includes only allowlisted untrusted summaries and enforces 12 KiB', () => {
  const handoff = buildTeamHandoff([
    completedChild('builder', {
      claimToken: 'must-not-leak',
      result: {
        candidateOid: 'b'.repeat(40),
        finalMessage: `candidate details ${'界'.repeat(20_000)}`,
        secret: 'must-not-leak',
      },
    }),
    completedChild('researcher'),
  ]);

  assert.ok(Buffer.byteLength(handoff, 'utf8') <= TEAM_HANDOFF_MAX_BYTES);
  assert.match(handoff, /untrusted/i);
  assert.match(handoff, /task-builder/);
  assert.match(handoff, new RegExp('b'.repeat(40)));
  assert.doesNotMatch(handoff, /must-not-leak/);

  const tinyHandoff = buildTeamHandoff([
    completedChild('builder', {
      result: { candidateOid: 'b'.repeat(40), finalMessage: '界'.repeat(10_000) },
    }),
  ], { maxBytes: 257 });
  assert.ok(Buffer.byteLength(tinyHandoff, 'utf8') <= 257);
  assert.doesNotMatch(tinyHandoff, /�/u);
});

test('aggregateTeamChildren deterministically derives the parent verdict and candidate', () => {
  const children = [
    completedChild('builder'),
    completedChild('researcher'),
    completedChild('test'),
    completedChild('reviewer', {
      result: {
        review: {
          schema: 'team.review.v1',
          verdict: 'APPROVED',
          findings: [],
        },
      },
    }),
    completedChild('verifier', {
      result: {
        verification: {
          schema: 'team.verify.v1',
          verdict: 'PASS',
          summary: 'Verified.',
          checks: [
            { name: 'npm test', status: 'PASS', evidence: 'passed' },
            { name: 'npm run check', status: 'PASS', evidence: 'passed' },
          ],
        },
      },
    }),
  ];

  const aggregate = aggregateTeamChildren({
    parentTask: {
      result: { plan: validPlan() },
      taskId: 'parent-1',
    },
    children,
  });

  assert.equal(aggregate.ok, true);
  assert.equal(aggregate.result.verdict, 'READY_FOR_HUMAN');
  assert.equal(aggregate.result.candidateOid, 'b'.repeat(40));
  assert.deepEqual(aggregate.result.childTaskIds, children.map((child) => child.taskId));

  const failed = aggregateTeamChildren({
    parentTask: { result: { plan: validPlan() }, taskId: 'parent-1' },
    children: children.map((child) => (
      child.sliceKey === 'test'
        ? { ...child, state: 'failed', error: { message: 'tests failed' } }
        : child
    )),
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error.message, /test/i);

  assert.throws(
    () => aggregateTeamChildren({
      parentTask: {
        result: { plan: validPlan() },
        taskId: 'parent-1',
      },
      children: children.map((child) => (
        child.sliceKey === 'verifier'
          ? {
            ...child,
            result: {
              verification: {
                schema: 'team.verify.v1',
                verdict: 'PASS',
                summary: 'Ran the wrong check.',
                checks: [{ name: 'npm run check', status: 'PASS', evidence: 'passed' }],
              },
            },
          }
          : child
      )),
    }),
    /missing required PASS check "npm test"/i,
  );
});
