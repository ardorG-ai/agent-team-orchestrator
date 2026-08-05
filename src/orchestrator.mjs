import { createHash } from 'node:crypto';

import { runClaude, runCodex } from './adapters.mjs';
import { renderRoleLoadout } from './project-assets.mjs';
import { OutboxBackpressureError } from './project-store.mjs';
import { buildTaskPrompt as defaultBuildPrompt } from './task-prompt.mjs';
import {
  aggregateTeamChildren,
  assertRequiredVerificationChecks,
  assertExecutionSnapshot,
  buildTeamChildren,
  buildTeamHandoff,
  normalizeTeamReport,
  parseTeamPlan,
  parseTeamReview,
  parseTeamVerification,
  resolveExecutionMode,
  TEAM_REVIEW_JSON_SCHEMA,
} from './team-workflow.mjs';
import {
  commitWorktreeCandidate as defaultCommitWorktreeCandidate,
  createWorktree as defaultCreateWorktree,
  snapshotWorktree as defaultSnapshotWorktree,
} from './worktree.mjs';

const DEFAULT_ADAPTERS = Object.freeze({
  claude: runClaude,
  codex: runCodex,
});

const DEFAULT_REVIEW_CHANNEL = 'review';

function requireObject(name, value) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`${name} must be an object`);
  }
}

function requireString(name, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function requirePositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function selectAdapterName(explicitAdapter, payload = {}) {
  const candidate = explicitAdapter ?? payload.adapter ?? 'codex';
  if (candidate !== 'codex' && candidate !== 'claude') {
    throw new TypeError(`unsupported adapter "${candidate}"`);
  }
  return candidate;
}

function buildCompletionResult({
  adapterName,
  claim,
  executionMode,
  runResult,
  snapshot,
  worktree,
}) {
  const result = {
    adapter: adapterName,
    baseOid: worktree.baseOid,
    branchName: worktree.branchName,
    candidateOid: snapshot.candidateOid,
    finalMessage: runResult.finalMessage ?? null,
    nativeSessionId: runResult.nativeSessionId ?? null,
    nativeThreadId: runResult.nativeThreadId ?? null,
    taskId: claim.taskId,
    worktreePath: worktree.worktreePath,
  };

  if (executionMode === 'standalone') {
    return result;
  }

  result.executionMode = executionMode;
  result.role = claim.payload?.role ?? null;
  if (executionMode === 'planner') {
    result.finalMessage = null;
    result.plan = parseTeamPlan(runResult.finalMessage);
  } else if (executionMode === 'report') {
    result.finalMessage = normalizeTeamReport(runResult.finalMessage);
  } else if (executionMode === 'review') {
    result.review = parseTeamReview(runResult.finalMessage);
  } else if (executionMode === 'verify') {
    result.verification = assertRequiredVerificationChecks(
      parseTeamVerification(runResult.finalMessage),
      claim.payload?.requiredChecks,
    );
  }

  return result;
}

function buildReviewPayload({
  adapterName,
  claim,
  runResult,
  snapshot,
  worker,
  worktree,
}) {
  return {
    adapter: adapterName,
    baseOid: worktree.baseOid,
    branchName: worktree.branchName,
    candidateOid: snapshot.candidateOid,
    finalMessage: runResult.finalMessage ?? null,
    generation: claim.generation,
    nativeSessionId: runResult.nativeSessionId ?? null,
    nativeThreadId: runResult.nativeThreadId ?? null,
    taskId: claim.taskId,
    worker,
    worktreePath: worktree.worktreePath,
  };
}

function buildAdapterFailure(adapterName, runResult) {
  return {
    aborted: runResult?.aborted ?? false,
    adapter: adapterName,
    diagnostics: Array.isArray(runResult?.diagnostics) ? runResult.diagnostics : [],
    exitCode: runResult?.exitCode ?? null,
    finalMessage: runResult?.finalMessage ?? null,
    message:
      runResult?.terminal?.message
      ?? runResult?.finalMessage
      ?? `${adapterName} adapter failed`,
    name: 'AdapterRunError',
    nativeSessionId: runResult?.nativeSessionId ?? null,
    nativeThreadId: runResult?.nativeThreadId ?? null,
    terminal: runResult?.terminal ?? null,
    timedOut: runResult?.timedOut ?? false,
  };
}

function buildRuntimeEventPayload(adapterName, runResult) {
  return {
    aborted: runResult?.aborted ?? false,
    adapter: adapterName,
    exitCode: runResult?.exitCode ?? null,
    nativeSessionId: runResult?.nativeSessionId ?? null,
    nativeThreadId: runResult?.nativeThreadId ?? null,
    ok: runResult?.ok === true,
    terminalStatus: runResult?.terminal?.status ?? null,
    timedOut: runResult?.timedOut ?? false,
  };
}

function buildPreparationEventPayload(adapterName, requestedRef, worktree) {
  return {
    adapter: adapterName,
    baseOid: worktree.baseOid,
    branchName: worktree.branchName,
    requestedRef,
    worktreePath: worktree.worktreePath,
  };
}

function isMutableExecution(executionMode) {
  return executionMode === 'standalone' || executionMode === 'build';
}

function buildControllerCommitMessage(claim) {
  return `Preserve CLI isolation while producing a reviewable candidate

The controller captured the task-scoped working-tree changes for task
${claim.taskId} generation ${claim.generation} after the child CLI reported success.

Constraint: Child CLIs do not write linked-worktree Git metadata
Confidence: medium
Scope-risk: moderate
Reversibility: clean
Directive: Review and verify this candidate before landing it
Tested: Controller validated changed paths, exact base parent, and clean snapshot
Not-tested: Protected-branch integration`;
}

function buildCandidateFinalizedEventPayload(candidate, snapshot, worktree) {
  const changedPaths = Array.isArray(candidate?.changedPaths) ? candidate.changedPaths : [];
  const scope = Array.isArray(candidate?.scope) ? candidate.scope : [];
  const preview = (values) => values.slice(0, 16).map((value) => (
    value.length > 256 ? `${value.slice(0, 255)}…` : value
  ));
  return {
    baseOid: worktree.baseOid,
    candidateOid: snapshot.candidateOid,
    changedPathCount: changedPaths.length,
    changedPathsHash: createHash('sha256')
      .update(JSON.stringify(changedPaths))
      .digest('hex'),
    changedPathsPreview: preview(changedPaths),
    changedPathsTruncated: changedPaths.length > 16,
    controllerOwned: true,
    entryCount: Number.isInteger(candidate?.entryCount) ? candidate.entryCount : changedPaths.length,
    parentCount: Number.isInteger(candidate?.parentCount) ? candidate.parentCount : 1,
    parentOid: candidate?.parentOid ?? worktree.baseOid,
    scopeCount: scope.length,
    scopeHash: createHash('sha256')
      .update(JSON.stringify(scope))
      .digest('hex'),
    scopePreview: preview(scope),
    scopeTruncated: scope.length > 16,
  };
}

function resolveRoleReference(store, payload, maxBytes) {
  if (typeof store.resolveRoleLoadout !== 'function') {
    return null;
  }

  const role = payload.role ?? 'builder';
  const resolved = store.resolveRoleLoadout(role);
  if (!resolved) {
    return null;
  }

  return renderRoleLoadout(resolved, {
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
}

function resolveReviewChannel(options, payload) {
  return options.reviewChannel ?? payload.reviewChannel ?? payload.channel ?? DEFAULT_REVIEW_CHANNEL;
}

function resolveReviewCapacity(options, payload) {
  return options.reviewChannelCapacity ?? payload.reviewChannelCapacity ?? payload.channelCapacity;
}

function requireExactCandidateOid(name, value) {
  requireString(name, value);
  if (!/^[0-9a-f]{40,64}$/u.test(value)) {
    throw new TypeError(`${name} must be an exact hexadecimal commit OID`);
  }
  return value;
}

function resolveRequestedRef(store, claim, payload) {
  if (payload.baseFromTaskId === undefined) {
    return payload.baseOid ?? payload.base ?? payload.ref ?? 'HEAD';
  }

  requireString('payload.baseFromTaskId', payload.baseFromTaskId);
  if (!claim.parentTaskId) {
    throw new Error('payload.baseFromTaskId requires a parent team task');
  }
  if (typeof store.getTask !== 'function') {
    throw new TypeError('store.getTask is required for payload.baseFromTaskId');
  }
  const source = store.getTask(payload.baseFromTaskId);
  if (!source || source.state !== 'completed') {
    throw new Error(`base source task "${payload.baseFromTaskId}" must be completed`);
  }
  if (source.parentTaskId !== claim.parentTaskId) {
    throw new Error(`base source task "${payload.baseFromTaskId}" belongs to another parent`);
  }
  return requireExactCandidateOid(
    `task ${payload.baseFromTaskId} candidateOid`,
    source.result?.candidateOid,
  );
}

function resolveHandoff(store, claim, payload) {
  const taskIds = payload.handoffTaskIds ?? [];
  if (!Array.isArray(taskIds)) {
    throw new TypeError('payload.handoffTaskIds must be an array');
  }
  if (taskIds.length > 8) {
    throw new TypeError('payload.handoffTaskIds must contain at most 8 task ids');
  }
  for (const taskId of taskIds) requireString('payload.handoffTaskId', taskId);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new TypeError('payload.handoffTaskIds must be unique');
  }
  if (taskIds.length === 0) return null;
  if (!claim.parentTaskId) {
    throw new Error('payload.handoffTaskIds requires a parent team task');
  }
  if (typeof store.getTask !== 'function') {
    throw new TypeError('store.getTask is required for payload.handoffTaskIds');
  }

  const tasks = taskIds.map((taskId) => {
    const task = store.getTask(taskId);
    if (!task) throw new Error(`handoff task "${taskId}" does not exist`);
    if (task.parentTaskId !== claim.parentTaskId) {
      throw new Error(`handoff task "${taskId}" belongs to another parent`);
    }
    return task;
  });
  return buildTeamHandoff(tasks);
}

function buildTeamReviewPayload({ claim, result, worker }) {
  return {
    schema: 'team.delivery.v1',
    taskId: claim.taskId,
    generation: claim.generation,
    worker,
    candidateOid: result.candidateOid,
    verdict: result.verdict,
    childTaskIds: result.childTaskIds,
    reviewVerdict: result.review.verdict,
    verificationVerdict: result.verification.verdict,
  };
}

function resolveAdapterRunOptions(
  options,
  adapterName,
  executionMode,
  role,
  prompt,
  signal,
  worktreePath,
) {
  const adapterOptions = options.adapterOptions ?? {};
  const {
    claude: _claudeScoped,
    codex: _codexScoped,
    ...shared
  } = adapterOptions && typeof adapterOptions === 'object' && !Array.isArray(adapterOptions)
    ? adapterOptions
    : {};
  const scoped = adapterOptions
    && typeof adapterOptions === 'object'
    && !Array.isArray(adapterOptions)
    && adapterOptions[adapterName]
    && typeof adapterOptions[adapterName] === 'object'
    ? adapterOptions[adapterName]
    : {};

  const explicit = {};
  for (const key of [
    'env',
    'executable',
    'launcherArgs',
    'jsonSchema',
    'maxStderrBytes',
    'maxStdoutBytes',
    'timeoutMs',
    'tools',
  ]) {
    if (options[key] !== undefined) explicit[key] = options[key];
  }

  let roleDefaults = {};
  if (adapterName === 'claude'
    && executionMode === 'report'
    && role === 'researcher') {
    roleDefaults = { tools: ['Read', 'Grep', 'Glob'] };
  } else if (adapterName === 'claude'
    && executionMode === 'review'
    && role === 'reviewer') {
    roleDefaults = {
      jsonSchema: TEAM_REVIEW_JSON_SCHEMA,
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
    };
  }

  return {
    ...roleDefaults,
    ...shared,
    ...scoped,
    ...explicit,
    cwd: worktreePath,
    prompt,
    signal,
  };
}

function createAbortBridgeSignal(signals) {
  const controller = new AbortController();
  const cleanups = [];

  const abort = () => {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort();
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  };

  for (const signal of signals) {
    if (!(signal instanceof AbortSignal)) {
      continue;
    }
    if (signal.aborted) {
      abort();
      break;
    }
    const onAbort = () => abort();
    signal.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', onAbort));
  }

  return {
    signal: controller.signal,
    stop() {
      while (cleanups.length > 0) {
        cleanups.pop()?.();
      }
    },
  };
}

function startHeartbeat({ claim, leaseMs, store }) {
  const intervalMs = Math.max(1, Math.floor(leaseMs / 3));
  const controller = new AbortController();
  let lost = false;
  let failure = null;

  const timer = setInterval(() => {
    if (lost) {
      return;
    }

    try {
      const renewed = store.heartbeatTask({
        claimToken: claim.claimToken,
        generation: claim.generation,
        taskId: claim.taskId,
        ttlMs: leaseMs,
        worker: claim.worker,
      });

      if (renewed !== null) {
        return;
      }
    } catch (error) {
      failure = error;
    }

    if (!lost) {
      lost = true;
      controller.abort();
    }
  }, intervalMs);

  timer.unref?.();

  return {
    get failure() {
      return failure;
    },
    get lost() {
      return lost;
    },
    signal: controller.signal,
    stop() {
      clearInterval(timer);
    },
  };
}

function interruptClaim({ claim, options, store }) {
  const requeued = store.requeueTaskLease({
    availableAt: options.interruptAvailableAt,
    claimToken: claim.claimToken,
    generation: claim.generation,
    taskId: claim.taskId,
    worker: claim.worker,
  });

  if (!requeued) {
    return {
      claim,
      status: 'lost-lease',
    };
  }

  return {
    claim,
    status: 'interrupted',
    task: requeued,
  };
}

function assertSnapshot(snapshot) {
  if (!snapshot || snapshot.clean !== true) {
    throw new Error('snapshot requires a clean worktree');
  }

  requireString('snapshot.candidateOid', snapshot.candidateOid);
}

function requeueAfterBackpressure({ claim, error, options, store, extra = {} }) {
  const requeued = store.requeueTaskLease({
    availableAt: options.backpressureAvailableAt,
    claimToken: claim.claimToken,
    generation: claim.generation,
    taskId: claim.taskId,
    worker: claim.worker,
  });

  if (!requeued) {
    return {
      claim,
      error,
      ...extra,
      status: 'lost-lease',
    };
  }

  return {
    claim,
    error,
    ...extra,
    status: 'backpressure',
    task: requeued,
  };
}

function aggregatePlannerClaim({ claim, heartbeat, options, payload, store }) {
  if (typeof store.listTaskChildren !== 'function') {
    throw new TypeError('store.listTaskChildren is required to aggregate a team');
  }

  if (heartbeat.lost) {
    return { claim, status: 'lost-lease', worktree: null };
  }

  const children = store.listTaskChildren(claim.taskId);
  const aggregate = aggregateTeamChildren({ parentTask: claim, children });

  if (!aggregate.ok) {
    const failedTask = store.failTask({
      claimToken: claim.claimToken,
      error: aggregate.error,
      generation: claim.generation,
      preserveResult: true,
      taskId: claim.taskId,
      worker: claim.worker,
    });
    if (!failedTask) {
      return {
        claim,
        error: aggregate.error,
        status: 'lost-lease',
        worktree: null,
      };
    }
    return {
      claim,
      error: aggregate.error,
      status: 'failed',
      task: failedTask,
      worktree: null,
    };
  }

  let completed;
  try {
    completed = store.completeTask({
      claimToken: claim.claimToken,
      generation: claim.generation,
      outbox: {
        capacity: resolveReviewCapacity(options, payload),
        channel: resolveReviewChannel(options, payload),
        messageId: `team:${claim.taskId}:g${claim.generation}`,
        payload: buildTeamReviewPayload({
          claim,
          result: aggregate.result,
          worker: claim.worker,
        }),
      },
      result: aggregate.result,
      taskId: claim.taskId,
      worker: claim.worker,
    });
  } catch (error) {
    if (!(error instanceof OutboxBackpressureError)) throw error;
    return requeueAfterBackpressure({
      claim,
      error,
      options,
      store,
      extra: { worktree: null },
    });
  }

  if (!completed) {
    return { claim, status: 'lost-lease', worktree: null };
  }

  return {
    claim,
    outbox: completed.outbox,
    status: 'completed',
    task: completed.task,
    worktree: null,
  };
}

export async function runWorkerOnce(options = {}) {
  requireObject('options', options);
  requireObject('options.store', options.store);
  requireObject('options.context', options.context);
  requireString('options.worker', options.worker);

  const {
    buildPrompt = defaultBuildPrompt,
    commitWorktreeCandidate = defaultCommitWorktreeCandidate,
    createWorktree = defaultCreateWorktree,
    leaseMs = 30_000,
    snapshotWorktree = defaultSnapshotWorktree,
    store,
    taskId,
    worker,
  } = options;

  requirePositiveInteger('options.leaseMs', leaseMs);
  requireString('options.context.worktreeRoot', options.context.worktreeRoot);
  if (options.maxLoadoutBytes !== undefined) {
    requirePositiveInteger('options.maxLoadoutBytes', options.maxLoadoutBytes);
  }

  const adapters = {
    ...DEFAULT_ADAPTERS,
    ...(options.adapters ?? {}),
  };

  const activeClaimTokens = options.activeClaimTokens instanceof Set ? options.activeClaimTokens : null;
  const externalSignal = options.signal;
  if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) {
    throw new TypeError('options.signal must be an AbortSignal');
  }

  store.requeueExpiredTasks({
    ...(activeClaimTokens ? { excludeClaimTokens: [...activeClaimTokens] } : {}),
  });
  const claim = store.claimTask({ taskId, ttlMs: leaseMs, worker });
  if (!claim) {
    return { status: 'idle' };
  }
  activeClaimTokens?.add(claim.claimToken);

  const payload = claim.payload ?? {};
  const heartbeat = startHeartbeat({ claim, leaseMs, store });
  const adapterAbort = createAbortBridgeSignal([heartbeat.signal, externalSignal]);
  let worktree = null;

  try {
    const executionMode = resolveExecutionMode(payload);
    if (executionMode === 'planner' && claim.result?.plan) {
      return aggregatePlannerClaim({ claim, heartbeat, options, payload, store });
    }

    const roleReference = resolveRoleReference(store, payload, options.maxLoadoutBytes);
    if (roleReference) {
      const recordedLoadout = store.appendTaskEvent({
        claimToken: claim.claimToken,
        generation: claim.generation,
        payload: roleReference.receipt,
        taskId: claim.taskId,
        type: 'loadout-snapshot',
        worker: claim.worker,
      });

      if (!recordedLoadout || heartbeat.lost) {
        return {
          claim,
          status: 'lost-lease',
          worktree,
        };
      }
    }

    const requestedRef = resolveRequestedRef(store, claim, payload);
    const handoff = resolveHandoff(store, claim, payload);
    const adapterName = selectAdapterName(options.adapter, payload);
    const runAdapter = adapters[adapterName];
    if (typeof runAdapter !== 'function') {
      throw new TypeError(`adapter "${adapterName}" is not available`);
    }

    worktree = await createWorktree({
      generation: claim.generation,
      ref: requestedRef,
      repoPath: options.context.repoRoot ?? options.context.repoPath ?? process.cwd(),
      task: claim.taskId,
      worktreeRoot: options.context.worktreeRoot,
    });

    if (heartbeat.lost) {
      return {
        claim,
        status: 'lost-lease',
        worktree,
      };
    }

    const prepared = store.appendTaskEvent({
      claimToken: claim.claimToken,
      generation: claim.generation,
      payload: buildPreparationEventPayload(adapterName, requestedRef, worktree),
      taskId: claim.taskId,
      type: 'preparation',
      worker: claim.worker,
    });

    if (!prepared || heartbeat.lost) {
      return {
        claim,
        status: 'lost-lease',
        worktree,
      };
    }

    const prompt = buildPrompt(claim, claim, {
      baseOid: worktree.baseOid,
      branchName: worktree.branchName,
      repoRoot: worktree.worktreePath,
      handoff,
      roleReference,
      worktreePath: worktree.worktreePath,
    });

    let runResult;
    try {
      runResult = await runAdapter(
        resolveAdapterRunOptions(
          options,
          adapterName,
          executionMode,
          payload.role,
          prompt,
          adapterAbort.signal,
          worktree.worktreePath,
        ),
      );
    } catch (error) {
      runResult = {
        aborted: adapterAbort.signal.aborted,
        diagnostics: [],
        exitCode: null,
        finalMessage: error instanceof Error ? error.message : String(error),
        nativeSessionId: null,
        nativeThreadId: null,
        ok: false,
        terminal: {
          message: error instanceof Error ? error.message : String(error),
          status: 'failure',
        },
        timedOut: false,
      };
    }

    if (heartbeat.lost) {
      return {
        claim,
        run: runResult,
        status: 'lost-lease',
        worktree,
      };
    }

    const recordedRuntime = store.appendTaskEvent({
      claimToken: claim.claimToken,
      generation: claim.generation,
      payload: buildRuntimeEventPayload(adapterName, runResult),
      taskId: claim.taskId,
      type: 'runtime',
      worker: claim.worker,
    });

    if (!recordedRuntime || heartbeat.lost) {
      return {
        claim,
        run: runResult,
        status: 'lost-lease',
        worktree,
      };
    }

    if (externalSignal?.aborted) {
      return {
        ...interruptClaim({ claim, options, store }),
        run: runResult,
        worktree,
      };
    }

    if (runResult.ok !== true) {
      const failedTask = store.failTask({
        claimToken: claim.claimToken,
        error: buildAdapterFailure(adapterName, runResult),
        generation: claim.generation,
        taskId: claim.taskId,
        worker: claim.worker,
      });

      if (!failedTask) {
        return {
          claim,
          run: runResult,
          status: 'lost-lease',
          worktree,
        };
      }

      return {
        claim,
        run: runResult,
        status: 'failed',
        task: failedTask,
        worktree,
      };
    }

    let candidate = null;
    if (isMutableExecution(executionMode)) {
      if (typeof commitWorktreeCandidate !== 'function') {
        throw new TypeError('options.commitWorktreeCandidate must be a function');
      }
      if (heartbeat.lost) {
        return {
          claim,
          run: runResult,
          status: 'lost-lease',
          worktree,
        };
      }

      candidate = await commitWorktreeCandidate({
        baseOid: worktree.baseOid,
        commitMessage: buildControllerCommitMessage(claim),
        scope: Array.isArray(payload.scope) ? payload.scope : [],
        worktreePath: worktree.worktreePath,
      });
    }

    const snapshot = await snapshotWorktree({ worktreePath: worktree.worktreePath });
    assertSnapshot(snapshot);
    assertExecutionSnapshot(executionMode, snapshot, worktree.baseOid);
    if (candidate?.candidateOid !== undefined && candidate.candidateOid !== snapshot.candidateOid) {
      throw new Error('clean worktree snapshot must resolve to the controller candidate OID');
    }
    if (candidate?.parentOid !== undefined && candidate.parentOid !== worktree.baseOid) {
      throw new Error('controller candidate parent must match the exact worktree base OID');
    }
    if (candidate?.parentCount !== undefined && candidate.parentCount !== 1) {
      throw new Error('controller candidate must have exactly one parent');
    }

    if (heartbeat.lost) {
      return {
        claim,
        run: runResult,
        snapshot,
        status: 'lost-lease',
        worktree,
      };
    }

    const completionResult = buildCompletionResult({
      adapterName,
      claim,
      executionMode,
      runResult,
      snapshot,
      worktree,
    });

    if (executionMode === 'planner') {
      if (typeof store.fanOutTask !== 'function') {
        throw new TypeError('store.fanOutTask is required for planner execution');
      }
      const children = buildTeamChildren({
        baseOid: worktree.baseOid,
        ...(options.generateTaskId ? { generateTaskId: options.generateTaskId } : {}),
        parentTask: claim,
        plan: completionResult.plan,
      });
      const fanOut = store.fanOutTask({
        children,
        claimToken: claim.claimToken,
        generation: claim.generation,
        result: completionResult,
        taskId: claim.taskId,
        worker: claim.worker,
      });
      if (!fanOut) {
        return {
          claim,
          run: runResult,
          snapshot,
          status: 'lost-lease',
          worktree,
        };
      }
      return {
        children: fanOut.children,
        claim,
        run: runResult,
        snapshot,
        status: 'waiting-children',
        task: fanOut.parent,
        worktree,
      };
    }

    const completionOutbox = executionMode === 'standalone'
      ? {
        capacity: resolveReviewCapacity(options, payload),
        channel: resolveReviewChannel(options, payload),
        messageId: `candidate:${claim.taskId}:g${claim.generation}`,
        payload: buildReviewPayload({
          adapterName,
          claim,
          runResult,
          snapshot,
          worker,
          worktree,
        }),
      }
      : null;
    let completed;
    try {
      completed = store.completeTask({
        claimToken: claim.claimToken,
        generation: claim.generation,
        ...(completionOutbox ? { outbox: completionOutbox } : {}),
        result: completionResult,
        ...(candidate ? {
          taskEvent: {
            payload: buildCandidateFinalizedEventPayload(candidate, snapshot, worktree),
            type: 'candidate-finalized',
          },
        } : {}),
        taskId: claim.taskId,
        worker: claim.worker,
      });
    } catch (error) {
      if (!(error instanceof OutboxBackpressureError)) {
        throw error;
      }
      return requeueAfterBackpressure({
        claim,
        error,
        options,
        store,
        extra: { run: runResult, snapshot, worktree },
      });
    }

    if (!completed) {
      return {
        claim,
        run: runResult,
        snapshot,
        status: 'lost-lease',
        worktree,
      };
    }

    return {
      claim,
      ...(completionOutbox ? { outbox: completed.outbox } : {}),
      run: runResult,
      snapshot,
      status: 'completed',
      task: completionOutbox ? completed.task : (completed.task ?? completed),
      worktree,
    };
  } catch (error) {
    if (heartbeat.lost) {
      return {
        claim,
        error: heartbeat.failure ?? error,
        status: 'lost-lease',
        worktree,
      };
    }

    const failedTask = store.failTask({
      claimToken: claim.claimToken,
      error,
      generation: claim.generation,
      taskId: claim.taskId,
      worker: claim.worker,
    });

    if (!failedTask) {
      return {
        claim,
        error,
        status: 'lost-lease',
        worktree,
      };
    }

    return {
      claim,
      error,
      status: 'failed',
      task: failedTask,
      worktree,
    };
  } finally {
    adapterAbort.stop();
    heartbeat.stop();
    activeClaimTokens?.delete(claim.claimToken);
  }
}

export default {
  runWorkerOnce,
};
