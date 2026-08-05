import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalParse, canonicalStringify } from './canonical-json.mjs';
import { runWorkerOnce as defaultRunWorkerOnce } from './orchestrator.mjs';
import { resolveCommitOid as defaultResolveCommitOid } from './worktree.mjs';

export const GUI_MUTATION_TOKEN_HEADER = 'x-agent-team-token';
const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024;
const DEFAULT_RUN_HISTORY_LIMIT = 200;
const DEFAULT_PROJECT_ASSET_LIMIT = 120;
const DEFAULT_ROLE_LOADOUT_LIMIT = 80;
const DEFAULT_WORKER_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function requireObject(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
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

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function ensureLoopbackHost(host) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new TypeError('GUI server host must be loopback-only');
  }
}

function toInteger(value, fallback, options = {}) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  const min = options.min ?? 1;
  const max = options.max ?? 1_000;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, 'invalid_integer', `Expected an integer between ${min} and ${max}`);
  }
  return parsed;
}

function publicContext(context) {
  return {
    artifactRoot: context.artifactRoot,
    branch: context.branch,
    projectDir: context.projectDir,
    repoId: context.repoId,
    repoName: context.repoRoot ? path.basename(context.repoRoot) : undefined,
    repoRoot: context.repoRoot,
    stateRoot: context.stateRoot,
    worktreeRoot: context.worktreeRoot,
  };
}

function expectedHostHeader(host, port) {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

function requireExpectedHost(request, host, port) {
  if (request.headers.host !== expectedHostHeader(host, port)) {
    throw new HttpError(421, 'unexpected_host', 'Host header does not match the loopback listener');
  }
}

function requireSameOrigin(request, origin) {
  const requestOrigin = request.headers.origin;
  if (requestOrigin !== origin) {
    throw new HttpError(403, 'invalid_origin', 'Mutation origin does not match the local GUI');
  }
}

function sanitizeForResponse(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeForResponse);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'claimToken' || key === 'leaseToken') {
      continue;
    }
    output[key] = sanitizeForResponse(entry);
  }
  return output;
}

function setCommonHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'",
  );
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(response, statusCode, payload) {
  const body = canonicalStringify(payload);
  response.statusCode = statusCode;
  setCommonHeaders(response);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(body);
}

function sendText(response, statusCode, contentType, body) {
  response.statusCode = statusCode;
  setCommonHeaders(response);
  response.setHeader('Content-Type', `${contentType}; charset=utf-8`);
  response.end(body);
}

async function readJsonBody(request, bodyLimitBytes) {
  const contentType = request.headers['content-type'];
  const contentLengthHeader = request.headers['content-length'];
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isInteger(contentLength) && contentLength > bodyLimitBytes) {
      throw new HttpError(413, 'body_too_large', 'Request body exceeds the configured limit');
    }
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > bodyLimitBytes) {
      throw new HttpError(413, 'body_too_large', 'Request body exceeds the configured limit');
    }
    chunks.push(chunk);
  }

  if (total === 0) {
    return {};
  }

  if (typeof contentType !== 'string' || !contentType.startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }

  try {
    return canonicalParse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new HttpError(400, 'invalid_json', error instanceof Error ? error.message : 'Invalid JSON body');
  }
}

function assertAllowedKeys(body, allowedKeys) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new HttpError(400, 'unexpected_field', `Unexpected field "${key}"`);
    }
  }
}

function requireMutationToken(request, expectedToken) {
  const provided = request.headers[GUI_MUTATION_TOKEN_HEADER];
  if (provided !== expectedToken) {
    throw new HttpError(403, 'invalid_mutation_token', 'Missing or invalid mutation token');
  }
}

function parseEvents(store, limit) {
  return store.listEventLog()
    .slice(-limit)
    .map((event) => ({
      seq: event.seq,
      occurredAt: event.occurred_at,
      kind: event.kind,
      entityType: event.entity_type,
      entityId: event.entity_id,
      payload: sanitizeForResponse(canonicalParse(event.payload_json)),
      prevHash: event.prev_hash,
      entryHash: event.entry_hash,
      signature: event.signature,
    }));
}

function publicDaemonStatus(status) {
  if (!status) {
    return null;
  }

  return {
    activeRuns: status.activeRuns,
    concurrency: status.concurrency,
    errorCount: Array.isArray(status.errors) ? status.errors.length : 0,
    leaseMs: status.leaseMs,
    pollMs: status.pollMs,
    running: status.running,
    startedAt: status.startedAt,
    timeoutMs: status.timeoutMs,
  };
}

function callOptionalStoreMethod(store, methodName, ...args) {
  const method = store?.[methodName];
  if (typeof method !== 'function') {
    return null;
  }
  return method.apply(store, args);
}

function boundedPreview(value, maxLength = 180) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`;
}

function publicProjectAsset(asset) {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
    return asset;
  }

  const {
    contentText,
    source: _source,
    ...metadata
  } = asset;
  return {
    ...metadata,
    contentBytes: typeof contentText === 'string' ? Buffer.byteLength(contentText, 'utf8') : null,
    preview: boundedPreview(contentText),
  };
}

function listProjectAssetsProjection(store, { kind, limit = DEFAULT_PROJECT_ASSET_LIMIT } = {}) {
  const assets = callOptionalStoreMethod(store, 'listProjectAssets', {
    kind: kind || undefined,
    limit,
  });
  return Array.isArray(assets) ? assets.map(publicProjectAsset) : [];
}

function listRoleLoadoutBindingsProjection(store) {
  const bindings = callOptionalStoreMethod(store, 'listRoleLoadoutBindings');
  return Array.isArray(bindings) ? bindings : [];
}

function listRoleLoadoutsProjection(store, { role, limit = DEFAULT_ROLE_LOADOUT_LIMIT } = {}) {
  const loadouts = callOptionalStoreMethod(store, 'listRoleLoadouts', {
    limit,
    role: role || undefined,
  });
  return Array.isArray(loadouts) ? loadouts : [];
}

function resolveRoleLoadoutProjection(store, role) {
  if (!role) {
    return null;
  }
  const resolved = callOptionalStoreMethod(store, 'resolveRoleLoadout', role);
  if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
    return null;
  }
  return {
    ...resolved,
    assets: Array.isArray(resolved.assets)
      ? resolved.assets.map(publicProjectAsset)
      : [],
  };
}

function buildSnapshot({ context, daemonStatus, runRegistry, store, taskLimit, outboxLimit, eventLimit }) {
  return sanitizeForResponse({
    channels: store.listChannels(),
    context: publicContext(context),
    daemon: publicDaemonStatus(daemonStatus),
    eventHead: store.getEventHead(),
    events: parseEvents(store, eventLimit),
    outbox: store.listOutbox({ limit: outboxLimit }),
    projectAssets: listProjectAssetsProjection(store),
    roleLoadoutBindings: listRoleLoadoutBindingsProjection(store),
    roleLoadouts: listRoleLoadoutsProjection(store),
    runs: runRegistry.list(),
    tasks: store.listTasks({ limit: taskLimit }),
    verify: {
      eventLog: store.verifyEventLog(),
      integrityCheck: store.integrityCheck(),
    },
  });
}

function createRunRegistry({ now, runHistoryLimit, runWorkerOnceFn, store, context, workerTimeoutMs }) {
  const runs = new Map();
  const activeTaskRuns = new Map();
  const activePromises = new Set();
  let accepting = true;

  function pruneCompletedRuns() {
    const completed = [...runs.values()]
      .filter((run) => run.finishedAt !== null)
      .sort((left, right) => left.finishedAt - right.finishedAt || left.runId.localeCompare(right.runId));
    const removeCount = Math.max(0, completed.length - runHistoryLimit);
    for (let index = 0; index < removeCount; index += 1) {
      runs.delete(completed[index].runId);
    }
  }

  function getRun(runId) {
    const run = runs.get(runId);
    return run ? sanitizeForResponse(run) : null;
  }

  function list() {
    return [...runs.values()]
      .sort((left, right) => left.startedAt - right.startedAt || left.runId.localeCompare(right.runId))
      .map(sanitizeForResponse);
  }

  function start({ leaseMs, taskId, worker }) {
    if (!accepting) {
      throw new HttpError(503, 'server_draining', 'The local GUI is shutting down');
    }
    if (activeTaskRuns.has(taskId)) {
      throw new HttpError(409, 'task_run_active', `Task "${taskId}" already has an active background run`);
    }

    const runId = randomUUID();
    const entry = {
      finishedAt: null,
      leaseMs,
      runId,
      startedAt: now(),
      status: 'running',
      taskId,
      worker,
    };
    runs.set(runId, entry);
    activeTaskRuns.set(taskId, runId);

    let execution;
    execution = Promise.resolve()
      .then(() => runWorkerOnceFn({
        context,
        leaseMs,
        store,
        taskId,
        timeoutMs: workerTimeoutMs,
        worker,
      }))
      .then((result) => {
        entry.finishedAt = now();
        entry.result = sanitizeForResponse(result);
        entry.status = result?.status ?? 'completed';
      })
      .catch((error) => {
        entry.error = sanitizeForResponse({
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : 'Error',
        });
        entry.finishedAt = now();
        entry.status = 'threw';
      })
      .finally(() => {
        activeTaskRuns.delete(taskId);
        activePromises.delete(execution);
        pruneCompletedRuns();
      });
    activePromises.add(execution);

    return { run: sanitizeForResponse(entry) };
  }

  async function drain() {
    accepting = false;
    await Promise.allSettled([...activePromises]);
  }

  function stopAccepting() {
    accepting = false;
  }

  return {
    drain,
    getRun,
    list,
    start,
    stopAccepting,
  };
}

async function serveStaticAsset({ response, webRoot, pathname }) {
  const assetPath = (() => {
    switch (pathname) {
      case '/':
      case '/index.html':
        return { file: 'index.html', type: 'text/html' };
      case '/styles.css':
        return { file: 'styles.css', type: 'text/css' };
      case '/app.js':
        return { file: 'app.js', type: 'text/javascript' };
      default:
        return null;
    }
  })();

  if (!assetPath) {
    return false;
  }

  const filePath = path.join(webRoot, assetPath.file);
  let body;
  try {
    body = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new HttpError(404, 'asset_not_found', `Missing web asset "${assetPath.file}"`);
    }
    throw error;
  }

  sendText(response, 200, assetPath.type, body);
  return true;
}

export async function startGuiServer(options = {}) {
  requireObject('options', options);
  requireObject('options.store', options.store);
  requireObject('options.context', options.context);

  const {
    bodyLimitBytes = DEFAULT_BODY_LIMIT_BYTES,
    context,
    daemonStatus = null,
    host = '127.0.0.1',
    mutationToken = randomUUID(),
    now = Date.now,
    port = 0,
    resolveCommitOidFn = defaultResolveCommitOid,
    runHistoryLimit = DEFAULT_RUN_HISTORY_LIMIT,
    runWorkerOnceFn = defaultRunWorkerOnce,
    store,
    webRoot = DEFAULT_WEB_ROOT,
    workerTimeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
  } = options;

  requirePositiveInteger('bodyLimitBytes', bodyLimitBytes);
  requirePositiveInteger('runHistoryLimit', runHistoryLimit);
  requirePositiveInteger('workerTimeoutMs', workerTimeoutMs);
  ensureLoopbackHost(host);
  if (!Number.isInteger(port) || port < 0) {
    throw new TypeError('port must be a non-negative integer');
  }
  requireString('mutationToken', mutationToken);
  if (typeof resolveCommitOidFn !== 'function') {
    throw new TypeError('resolveCommitOidFn must be a function');
  }
  if (typeof runWorkerOnceFn !== 'function') {
    throw new TypeError('runWorkerOnceFn must be a function');
  }
  if (daemonStatus !== null) {
    requireObject('daemonStatus', daemonStatus);
  }

  const runRegistry = createRunRegistry({
    context,
    now,
    runHistoryLimit,
    runWorkerOnceFn,
    store,
    workerTimeoutMs,
  });

  let boundPort = null;
  let serverOrigin = null;
  const server = createServer(async (request, response) => {
    try {
      requireExpectedHost(request, host, boundPort);
      const method = request.method ?? 'GET';
      const url = new URL(request.url ?? '/', `http://${host}`);
      const pathname = url.pathname;

      if (method === 'GET' && await serveStaticAsset({ response, webRoot, pathname })) {
        return;
      }

      if (pathname === '/api/snapshot' && method === 'GET') {
        sendJson(response, 200, buildSnapshot({
          context,
          daemonStatus,
          eventLimit: toInteger(url.searchParams.get('eventLimit'), 25),
          outboxLimit: toInteger(url.searchParams.get('outboxLimit'), 25),
          runRegistry,
          store,
          taskLimit: toInteger(url.searchParams.get('taskLimit'), 50),
        }));
        return;
      }

      if (pathname === '/api/tasks' && method === 'GET') {
        const limit = toInteger(url.searchParams.get('limit'), 100);
        const tasks = store.listTasks({
          keyPrefix: url.searchParams.get('keyPrefix') || undefined,
          limit,
          state: url.searchParams.get('state') || undefined,
          taskIds: url.searchParams.getAll('taskId'),
          worker: url.searchParams.get('worker') || undefined,
        });
        sendJson(response, 200, { tasks: sanitizeForResponse(tasks) });
        return;
      }

      if (pathname === '/api/project-assets' && method === 'GET') {
        const limit = toInteger(url.searchParams.get('limit'), DEFAULT_PROJECT_ASSET_LIMIT, { max: 200 });
        sendJson(response, 200, {
          projectAssets: sanitizeForResponse(listProjectAssetsProjection(store, {
            kind: url.searchParams.get('kind') || undefined,
            limit,
          })),
        });
        return;
      }

      if (pathname === '/api/role-loadouts' && method === 'GET') {
        const role = url.searchParams.get('role') || undefined;
        const limit = toInteger(url.searchParams.get('limit'), DEFAULT_ROLE_LOADOUT_LIMIT, { max: 200 });
        sendJson(response, 200, {
          roleLoadoutBindings: sanitizeForResponse(listRoleLoadoutBindingsProjection(store)),
          roleLoadouts: sanitizeForResponse(listRoleLoadoutsProjection(store, { limit, role })),
          resolvedRoleLoadout: sanitizeForResponse(resolveRoleLoadoutProjection(store, role)),
        });
        return;
      }

      if (pathname === '/api/channels' && method === 'GET') {
        sendJson(response, 200, { channels: sanitizeForResponse(store.listChannels()) });
        return;
      }

      if (pathname === '/api/events' && method === 'GET') {
        sendJson(response, 200, {
          eventHead: sanitizeForResponse(store.getEventHead()),
          events: parseEvents(store, toInteger(url.searchParams.get('limit'), 100)),
        });
        return;
      }

      if (pathname === '/api/verify' && method === 'GET') {
        sendJson(response, 200, sanitizeForResponse({
          eventLog: store.verifyEventLog(),
          integrityCheck: store.integrityCheck(),
        }));
        return;
      }

      if (pathname === '/api/runs' && method === 'GET') {
        sendJson(response, 200, { runs: runRegistry.list() });
        return;
      }

      if (pathname === '/api/tasks' && method === 'POST') {
        requireSameOrigin(request, serverOrigin);
        requireMutationToken(request, mutationToken);
        const body = await readJsonBody(request, bodyLimitBytes);
        assertAllowedKeys(body, ['availableAt', 'dependencies', 'key', 'payload', 'taskId']);
        requireString('key', body.key);
        requireObject('payload', body.payload);
        const dependencies = body.dependencies ?? body.payload.dependencies ?? [];
        if (!Array.isArray(dependencies)) {
          throw new HttpError(400, 'invalid_dependencies', 'dependencies must be an array');
        }
        const requestedBase = body.payload.baseOid ?? body.payload.base ?? 'HEAD';
        requireString('payload.base', requestedBase);
        const baseOid = await resolveCommitOidFn(context.repoRoot, requestedBase);
        const payload = {
          ...body.payload,
          baseOid,
          baseRef: requestedBase,
          dependencies,
        };
        delete payload.base;
        const result = store.createTask({
          ...body,
          dependencies,
          payload,
        });
        sendJson(response, result.status === 'created' ? 201 : 200, sanitizeForResponse(result));
        return;
      }

      const runMatch = /^\/api\/tasks\/([^/]+)\/run$/.exec(pathname);
      if (runMatch && method === 'POST') {
        requireSameOrigin(request, serverOrigin);
        requireMutationToken(request, mutationToken);
        if (daemonStatus !== null) {
          throw new HttpError(
            409,
            'daemon_managed_run',
            'The resident daemon automatically schedules queued tasks',
          );
        }
        const body = await readJsonBody(request, bodyLimitBytes);
        assertAllowedKeys(body, ['leaseMs', 'worker']);
        const taskId = decodeURIComponent(runMatch[1]);
        const worker = body.worker ?? `gui:${process.pid}`;
        requireString('worker', worker);
        if (body.leaseMs !== undefined) {
          requirePositiveInteger('leaseMs', body.leaseMs);
        }
        const started = runRegistry.start({
          leaseMs: body.leaseMs,
          taskId,
          worker,
        });
        sendJson(response, 202, started);
        return;
      }

      const retryMatch = /^\/api\/tasks\/([^/]+)\/retry$/.exec(pathname);
      if (retryMatch && method === 'POST') {
        requireSameOrigin(request, serverOrigin);
        requireMutationToken(request, mutationToken);
        const body = await readJsonBody(request, bodyLimitBytes);
        assertAllowedKeys(body, ['availableAt', 'expectedGeneration', 'reason']);
        if (!Number.isInteger(body.expectedGeneration) || body.expectedGeneration < 0) {
          throw new HttpError(400, 'invalid_generation', 'expectedGeneration must be a non-negative integer');
        }
        if (body.reason !== undefined && body.reason !== null) {
          requireString('reason', body.reason);
        }
        const retried = store.retryFailedTask({
          availableAt: body.availableAt,
          expectedGeneration: body.expectedGeneration,
          reason: body.reason ?? null,
          taskId: decodeURIComponent(retryMatch[1]),
        });
        if (!retried) {
          throw new HttpError(409, 'retry_rejected', 'Task could not be retried with the requested generation');
        }
        sendJson(response, 200, { task: sanitizeForResponse(retried) });
        return;
      }

      if (pathname.startsWith('/api/')) {
        throw new HttpError(404, 'not_found', `No API route for ${method} ${pathname}`);
      }

      throw new HttpError(404, 'not_found', `No route for ${method} ${pathname}`);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.statusCode, {
          error: {
            code: error.code,
            message: error.message,
          },
        });
        return;
      }

      sendJson(response, 500, {
        error: {
          code: 'internal_error',
          message: 'The local GUI encountered an internal error',
        },
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind GUI server to a TCP loopback port');
  }
  boundPort = address.port;
  serverOrigin = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;

  let closePromise = null;

  return {
    close() {
      if (closePromise) {
        return closePromise;
      }

      runRegistry.stopAccepting();
      const serverCloseOutcome = new Promise((resolve) => {
        server.close((error) => {
          resolve({ error: error ?? null });
        });
      });

      closePromise = (async () => {
        await runRegistry.drain();
        const outcome = await serverCloseOutcome;
        if (outcome.error) {
          throw outcome.error;
        }
      })();
      return closePromise;
    },
    host,
    launchUrl: `${serverOrigin}/#token=${encodeURIComponent(mutationToken)}`,
    mutationToken,
    port: address.port,
    server,
    url: serverOrigin,
  };
}

export default {
  GUI_MUTATION_TOKEN_HEADER,
  startGuiServer,
};
