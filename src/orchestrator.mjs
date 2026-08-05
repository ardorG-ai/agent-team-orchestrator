import { runClaude, runCodex } from './adapters.mjs';
import { renderRoleLoadout } from './project-assets.mjs';
import { OutboxBackpressureError } from './project-store.mjs';
import { buildTaskPrompt as defaultBuildPrompt } from './task-prompt.mjs';
import {
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
  runResult,
  snapshot,
  worktree,
}) {
  return {
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

function resolveAdapterRunOptions(options, adapterName, prompt, signal, worktreePath) {
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
    'maxStderrBytes',
    'maxStdoutBytes',
    'timeoutMs',
  ]) {
    if (options[key] !== undefined) explicit[key] = options[key];
  }

  return {
    ...shared,
    ...scoped,
    ...explicit,
    cwd: worktreePath,
    prompt,
    signal,
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

function assertSnapshot(snapshot) {
  if (!snapshot || snapshot.clean !== true) {
    throw new Error('snapshot requires a clean worktree');
  }

  requireString('snapshot.candidateOid', snapshot.candidateOid);
}

export async function runWorkerOnce(options = {}) {
  requireObject('options', options);
  requireObject('options.store', options.store);
  requireObject('options.context', options.context);
  requireString('options.worker', options.worker);

  const {
    buildPrompt = defaultBuildPrompt,
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

  store.requeueExpiredTasks();
  const claim = store.claimTask({ taskId, ttlMs: leaseMs, worker });
  if (!claim) {
    return { status: 'idle' };
  }

  const payload = claim.payload ?? {};
  const heartbeat = startHeartbeat({ claim, leaseMs, store });
  let worktree = null;

  try {
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

    const requestedRef = payload.baseOid ?? payload.base ?? payload.ref ?? 'HEAD';
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
      roleReference,
      worktreePath: worktree.worktreePath,
    });

    let runResult;
    try {
      runResult = await runAdapter(
        resolveAdapterRunOptions(
          options,
          adapterName,
          prompt,
          heartbeat.signal,
          worktree.worktreePath,
        ),
      );
    } catch (error) {
      runResult = {
        aborted: heartbeat.signal.aborted,
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

    const snapshot = await snapshotWorktree({ worktreePath: worktree.worktreePath });
    assertSnapshot(snapshot);

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
      runResult,
      snapshot,
      worktree,
    });
    let completed;
    try {
      completed = store.completeTask({
        claimToken: claim.claimToken,
        generation: claim.generation,
        outbox: {
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
        },
        result: completionResult,
        taskId: claim.taskId,
        worker: claim.worker,
      });
    } catch (error) {
      if (!(error instanceof OutboxBackpressureError)) {
        throw error;
      }

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
          run: runResult,
          snapshot,
          status: 'lost-lease',
          worktree,
        };
      }

      return {
        claim,
        error,
        run: runResult,
        snapshot,
        status: 'backpressure',
        task: requeued,
        worktree,
      };
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
      outbox: completed.outbox,
      run: runResult,
      snapshot,
      status: 'completed',
      task: completed.task,
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
    heartbeat.stop();
  }
}

export default {
  runWorkerOnce,
};
