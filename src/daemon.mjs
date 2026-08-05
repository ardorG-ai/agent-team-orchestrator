import { startGuiServer as defaultStartGuiServer } from './gui-server.mjs';
import { runWorkerOnce as defaultRunWorkerOnce } from './orchestrator.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const MAX_ERROR_HISTORY = 20;

function requireObject(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function requirePositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function requireLoopbackHost(host) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new TypeError('daemon host must be loopback-only');
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function shouldPause(status) {
  return status !== 'completed';
}

async function sleepUntilNextPoll({ pollMs, sleep, stopPromise }) {
  await Promise.race([
    sleep(pollMs),
    stopPromise,
  ]);
}

function combineAbortSignals(signals) {
  const active = signals.filter(Boolean);
  if (active.length === 1) {
    return active[0];
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(active);
  }

  const controller = new AbortController();
  const abort = (signal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };
  for (const signal of active) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener('abort', () => abort(signal), { once: true });
  }
  return controller.signal;
}

export async function startDaemon(options = {}) {
  requireObject('options', options);
  requireObject('options.context', options.context);
  requireObject('options.store', options.store);

  const {
    concurrency = 1,
    context,
    host = '127.0.0.1',
    leaseMs = 30_000,
    now = Date.now,
    pollMs = 1_000,
    port = 4317,
    runWorkerOnce = defaultRunWorkerOnce,
    sleep = defaultSleep,
    startGuiServer = defaultStartGuiServer,
    store,
    timeoutMs = 30 * 60_000,
    workerNamePrefix = 'daemon',
  } = options;

  requirePositiveInteger('concurrency', concurrency);
  if (concurrency > 64) {
    throw new TypeError('concurrency must be 64 or less');
  }
  requirePositiveInteger('leaseMs', leaseMs);
  if (leaseMs > 60 * 60_000) {
    throw new TypeError('leaseMs must be 3600000 or less');
  }
  requirePositiveInteger('pollMs', pollMs);
  if (pollMs < 50 || pollMs > 60_000) {
    throw new TypeError('pollMs must be between 50 and 60000');
  }
  requirePositiveInteger('timeoutMs', timeoutMs);
  if (timeoutMs > 24 * 60 * 60_000) {
    throw new TypeError('timeoutMs must be 86400000 or less');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('port must be an integer between 0 and 65535');
  }
  requireLoopbackHost(host);
  if (typeof runWorkerOnce !== 'function') {
    throw new TypeError('runWorkerOnce must be a function');
  }
  if (typeof startGuiServer !== 'function') {
    throw new TypeError('startGuiServer must be a function');
  }
  if (typeof sleep !== 'function') {
    throw new TypeError('sleep must be a function');
  }

  const status = {
    activeRuns: 0,
    concurrency,
    errors: [],
    leaseMs,
    pollMs,
    running: true,
    startedAt: now(),
    stoppedAt: null,
    timeoutMs,
  };

  const activeClaimTokens = new Set();
  const shutdownController = new AbortController();

  function runManagedWorkerOnce(runOptions) {
    const signal = combineAbortSignals([shutdownController.signal, runOptions.signal]);

    return runWorkerOnce({
      ...runOptions,
      activeClaimTokens,
      signal,
    });
  }

  let stopResolve;
  const stopPromise = new Promise((resolve) => {
    stopResolve = resolve;
  });

  const gui = await startGuiServer({
    context,
    daemonStatus: status,
    host,
    port,
    runWorkerOnceFn: runManagedWorkerOnce,
    store,
    workerTimeoutMs: timeoutMs,
  });

  let stopping = false;
  let closed = false;

  function recordError(error, worker) {
    status.errors.push({
      at: now(),
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : 'Error',
      worker,
    });
    if (status.errors.length > MAX_ERROR_HISTORY) {
      status.errors.splice(0, status.errors.length - MAX_ERROR_HISTORY);
    }
  }

  async function workerLoop(slot) {
    const worker = `${workerNamePrefix}-${slot}`;

    while (!stopping) {
      status.activeRuns += 1;
      let result;
      try {
        result = await runManagedWorkerOnce({
          context,
          leaseMs,
          store,
          timeoutMs,
          worker,
        });
      } catch (error) {
        recordError(error, worker);
        result = { status: 'failed' };
      } finally {
        status.activeRuns -= 1;
      }

      if (stopping) {
        break;
      }

      if (shouldPause(result?.status)) {
        await sleepUntilNextPoll({
          pollMs,
          sleep,
          stopPromise,
        });
      }
    }
  }

  const loops = Array.from({ length: concurrency }, (_, index) => workerLoop(index + 1));

  async function close() {
    if (closed) {
      return;
    }
    closed = true;
    stopping = true;
    status.running = false;
    status.stoppedAt = now();
    stopResolve();
    shutdownController.abort();

    let guiCloseOutcome;
    try {
      guiCloseOutcome = Promise.resolve(gui.close()).then(
        () => ({ error: null }),
        (error) => ({ error }),
      );
    } catch (error) {
      guiCloseOutcome = Promise.resolve({ error });
    }
    await Promise.allSettled(loops);
    const outcome = await guiCloseOutcome;
    if (outcome.error) {
      throw outcome.error;
    }
  }

  return {
    close,
    host: gui.host,
    port: gui.port,
    status,
    url: gui.launchUrl ?? gui.url,
  };
}

export default {
  startDaemon,
};
