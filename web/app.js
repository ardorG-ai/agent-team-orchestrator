const launchParams = location.hash.startsWith('#token=')
  ? new URLSearchParams(location.hash.slice(1))
  : null;
const launchToken = launchParams?.get('token') ?? '';
if (launchToken) {
  sessionStorage.setItem('agent-team-token', launchToken);
  history.replaceState(null, '', '#tasks');
}
const mutationToken = launchToken || sessionStorage.getItem('agent-team-token') || '';

const state = {
  filter: 'all',
  inspectorMode: 'summary',
  loading: true,
  refreshing: false,
  selectedTaskId: null,
  snapshot: null,
  theme: localStorage.getItem('agent-team-theme') ?? 'auto',
  view: 'tasks',
};

const BRAIN_ROLE_ORDER = ['builder', 'reviewer', 'verifier', 'architect'];
const BRAIN_ROLE_LABELS = {
  architect: 'Architect',
  builder: 'Builder',
  reviewer: 'Reviewer',
  verifier: 'Verifier',
};
const BRAIN_KIND_ORDER = ['memory', 'skill', 'knowledge'];
const BRAIN_KIND_LABELS = {
  knowledge: 'Knowledge',
  memory: 'Memory',
  skill: 'Skill',
};

const elements = {
  activityEmpty: document.querySelector('#activity-empty'),
  activityFeed: document.querySelector('#activity-feed'),
  activityPanel: document.querySelector('#activity-panel'),
  agentActiveCount: document.querySelector('#agent-active-count'),
  agentRoster: document.querySelector('#agent-roster'),
  appShell: document.querySelector('#app-shell'),
  brainAssetGroups: document.querySelector('#brain-asset-groups'),
  brainMemoryEmpty: document.querySelector('#brain-memory-empty'),
  brainMemoryGrid: document.querySelector('#brain-memory-grid'),
  brainRoleGrid: document.querySelector('#brain-role-grid'),
  brainRolesEmpty: document.querySelector('#brain-roles-empty'),
  channelGrid: document.querySelector('#channel-grid'),
  closeTaskDialog: document.querySelector('#close-task-dialog'),
  controlHealth: document.querySelector('#control-health'),
  createTaskSubmit: document.querySelector('#create-task-submit'),
  dialogError: document.querySelector('#dialog-error'),
  emptyInspector: document.querySelector('#inspector-empty'),
  eventTimeline: document.querySelector('#event-timeline'),
  inspector: document.querySelector('#inspector'),
  inspectorContent: document.querySelector('#inspector-content'),
  integrityBanner: document.querySelector('#integrity-banner'),
  loadingBoard: document.querySelector('#loading-board'),
  metricEvents: document.querySelector('#metric-events'),
  metricIntegrity: document.querySelector('#metric-integrity'),
  metricQueued: document.querySelector('#metric-queued'),
  metricReview: document.querySelector('#metric-review'),
  metricRunning: document.querySelector('#metric-running'),
  newTaskButton: document.querySelector('#new-task-button'),
  projectBranch: document.querySelector('#project-branch'),
  projectName: document.querySelector('#project-name'),
  projectPath: document.querySelector('#project-path'),
  refreshButton: document.querySelector('#refresh-button'),
  reviewEmpty: document.querySelector('#review-empty'),
  reviewList: document.querySelector('#review-list'),
  reviewNavCount: document.querySelector('#review-nav-count'),
  taskBoard: document.querySelector('#task-board'),
  taskAdapterLabel: document.querySelector('#task-adapter-label'),
  taskDialog: document.querySelector('#task-dialog'),
  taskForm: document.querySelector('#task-form'),
  taskRoleField: document.querySelector('#task-role-field'),
  tasksEmpty: document.querySelector('#tasks-empty'),
  teamForest: document.querySelector('#team-forest'),
  teamMapCount: document.querySelector('#team-map-count'),
  teamMapPanel: document.querySelector('#team-map-panel'),
  teamRouting: document.querySelector('#team-routing'),
  themeLabel: document.querySelector('#theme-label'),
  themeToggle: document.querySelector('#theme-toggle'),
  toastRegion: document.querySelector('#toast-region'),
  verifyButton: document.querySelector('#verify-button'),
  workingAvatarStack: document.querySelector('#working-avatar-stack'),
  workingBar: document.querySelector('#working-bar'),
  workingDetail: document.querySelector('#working-detail'),
  workingTitle: document.querySelector('#working-title'),
};

const DEFAULT_TEAM_ADAPTERS = Object.freeze({
  builder: 'codex',
  researcher: 'claude',
  test: 'codex',
  reviewer: 'claude',
  verifier: 'codex',
});
const TEAM_ROSTER = [
  { adapter: 'codex', initials: 'PL', name: 'Planner', role: 'planner' },
  { adapter: 'codex', initials: 'BU', name: 'Builder', role: 'builder' },
  { adapter: 'claude', initials: 'RS', name: 'Researcher', role: 'researcher' },
  { adapter: 'codex', initials: 'TS', name: 'Test', role: 'test' },
  { adapter: 'claude', initials: 'RV', name: 'Reviewer', role: 'reviewer' },
  { adapter: 'codex', initials: 'VF', name: 'Verifier', role: 'verifier' },
];
const ADAPTER_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
};

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function shortId(value, size = 8) {
  if (!value) return 'none';
  return String(value).slice(0, size);
}

function fileName(value) {
  const parts = String(value ?? '').split('/').filter(Boolean);
  return parts.at(-1) ?? 'local repository';
}

function formatDate(value) {
  if (!Number.isFinite(Number(value))) return 'unknown';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Number(value)));
}

function formatDuration(start, end = Date.now()) {
  if (!Number.isFinite(Number(start))) return 'unknown';
  const seconds = Math.max(0, Math.round((Number(end) - Number(start)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function compactText(value, maxLength = 180) {
  if (value === null || value === undefined) return '';
  let text = '';
  if (typeof value === 'string') text = value;
  else if (Array.isArray(value)) text = value.join(', ');
  else if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function normalizeRole(role) {
  return compactText(role, 80).toLowerCase();
}

function shortHash(value, size = 12) {
  const text = compactText(value, size);
  return text && text.length > size ? text.slice(0, size) : text || 'none';
}

function titleForState(taskState) {
  return ({
    queued: '待执行',
    running: '运行中',
    waiting_children: '等待子任务',
    completed: '已完成',
    failed: '失败',
  })[taskState] ?? taskState;
}

function taskTitle(task) {
  return task?.payload?.title ?? task?.key ?? task?.taskId ?? 'Unnamed task';
}

function adapterForTask(task) {
  return task?.payload?.adapter === 'claude' ? 'claude' : 'codex';
}

function roleForTask(task) {
  return normalizeRole(task?.payload?.role ?? 'builder') || 'builder';
}

function parentTaskIdFor(task) {
  return task?.parentTaskId ?? task?.payload?.parentTaskId ?? null;
}

function sliceKeyFor(task) {
  return compactText(task?.sliceKey ?? task?.payload?.sliceKey, 100);
}

function rosterEntryForTask(task) {
  const role = roleForTask(task);
  return TEAM_ROSTER.find((entry) => entry.role === role) ?? {
    adapter: adapterForTask(task),
    initials: role.slice(0, 2).toUpperCase() || 'AG',
    name: role || 'Agent',
    role,
  };
}

function loadoutIdentity(loadout) {
  return loadout?.loadoutId ?? null;
}

function roleProjection(role) {
  const bindings = state.snapshot?.roleLoadoutBindings ?? [];
  const loadouts = state.snapshot?.roleLoadouts ?? [];
  const binding = bindings.find((entry) => normalizeRole(entry?.role) === role) ?? null;
  const loadout = binding
    ? loadouts.find((entry) => loadoutIdentity(entry) === binding.loadoutId) ?? null
    : loadouts.find((entry) => normalizeRole(entry?.role) === role) ?? null;

  return { binding, loadout, role };
}

function projectAssets() {
  return state.snapshot?.projectAssets ?? [];
}

function assetKind(asset) {
  return normalizeRole(asset?.kind ?? 'knowledge') || 'knowledge';
}

function assetTitle(asset) {
  return compactText(asset?.title ?? asset?.assetKey ?? asset?.assetId ?? 'Untitled asset', 140);
}

function assetLayer(asset) {
  return compactText(asset?.memoryLayer, 60);
}

function assetRevision(asset) {
  return compactText(asset?.revision, 60);
}

function assetHash(asset) {
  return compactText(asset?.contentHash, 64);
}

function loadoutEntrySummary(loadout) {
  const entries = Array.isArray(loadout?.entries) ? loadout.entries : [];
  if (entries.length === 0) {
    return '当前 loadout 没有关联资产。';
  }
  const modeCounts = new Map();
  for (const entry of entries) {
    modeCounts.set(entry.injectionMode, (modeCounts.get(entry.injectionMode) ?? 0) + 1);
  }
  const modeSummary = ['direct', 'summary', 'reference', 'tool']
    .filter((mode) => modeCounts.has(mode))
    .map((mode) => `${mode} ${modeCounts.get(mode)}`)
    .join(' · ');
  return `${entries.length} 个资产 · ${modeSummary}`;
}

function assetPreview(asset) {
  const preview = compactText(asset?.preview, 120);
  if (preview) return preview;
  return compactText(asset?.assetKey, 120);
}

function appendFactList(container, facts) {
  const usableFacts = facts.filter(([, value]) => value);
  if (usableFacts.length === 0) return;
  const list = createElement('dl', 'brain-fact-list');
  for (const [label, value] of usableFacts) {
    const item = document.createElement('div');
    item.append(
      createElement('dt', null, label),
      createElement('dd', null, value),
    );
    list.append(item);
  }
  container.append(list);
}

function agentProjection() {
  const tasks = state.snapshot?.tasks ?? [];
  const runs = state.snapshot?.runs ?? [];

  return TEAM_ROSTER.map((agent) => {
    const agentTasks = tasks.filter((task) => roleForTask(task) === agent.role);
    const running = agentTasks.filter((task) => (
      task.state === 'running' || task.state === 'waiting_children'
    ));
    const queued = agentTasks.filter((task) => task.state === 'queued');
    const failed = agentTasks.filter((task) => task.state === 'failed');
    const activeRuns = runs.filter((run) => (
      run.status === 'running' && roleForTask(getTask(run.taskId)) === agent.role
    ));
    const current = running[0] ?? getTask(activeRuns[0]?.taskId) ?? queued[0] ?? failed[0] ?? null;
    const status = running.length > 0 || activeRuns.length > 0
      ? 'working'
      : queued.length > 0
        ? 'ready'
        : failed.length > 0
          ? 'attention'
          : 'idle';
    const headline = status === 'working'
      ? taskTitle(current)
      : status === 'ready'
        ? `${queued.length} 个任务待接手`
        : status === 'attention'
          ? `${failed.length} 个任务需要处理`
          : '等待新任务';

    return {
      ...agent,
      adapter: current ? adapterForTask(current) : agent.adapter,
      current,
      failed: failed.length,
      headline,
      queued: queued.length,
      running: Math.max(running.length, activeRuns.length),
      status,
    };
  });
}

function eventTask(event) {
  const taskId = event.entityType === 'task'
    ? event.entityId
    : event.payload?.taskId;
  return taskId ? getTask(taskId) : null;
}

function actorForEvent(event) {
  const task = eventTask(event);
  if (task) {
    const adapter = adapterForTask(task);
    const agent = rosterEntryForTask(task);
    return {
      initials: agent.initials,
      name: event.payload?.worker ?? `${agent.name} · ${ADAPTER_LABELS[adapter]}`,
      type: adapter,
    };
  }
  if (event.entityType === 'channel' || event.kind === 'outbox.channel-configured' || event.kind === 'outbox.channel-updated') {
    return { initials: 'CP', name: 'Control plane', type: 'control' };
  }
  if (event.kind.startsWith('outbox.')) {
    return { initials: 'RV', name: 'Review channel', type: 'review' };
  }
  return { initials: 'CP', name: 'Control plane', type: 'control' };
}

function eventHeadline(event) {
  const task = eventTask(event);
  const title = taskTitle(task);
  const payload = event.payload ?? {};

  if (event.kind === 'task.created') return `已将“${title}”写入队列`;
  if (event.kind === 'task.claimed') return `接手“${title}”，租约代次 g${payload.generation ?? task?.generation ?? '?'}`;
  if (event.kind === 'task.heartbeat') return `仍在处理“${title}”`;
  if (event.kind === 'task.event.runtime') {
    const runtime = payload.payload ?? {};
    return runtime.ok === true
      ? `完成“${title}”的运行阶段`
      : `“${title}”的运行阶段返回失败`;
  }
  if (event.kind === 'task.completed') return `产出“${title}”的候选提交，等待审核`;
  if (event.kind === 'task.failed') return `“${title}”需要人工处理`;
  if (event.kind === 'task.requeued') return `将“${title}”重新放回队列`;
  if (event.kind === 'task.retried') return `批准重试“${title}”`;
  if (event.kind === 'outbox.enqueued') return `向 ${payload.channel ?? 'review'} 频道发布一条候选消息`;
  if (event.kind === 'outbox.claimed') return `审核消息已被 ${payload.consumer ?? payload.worker ?? 'reviewer'} 领取`;
  if (event.kind === 'outbox.acked') return '审核消息已确认处理';
  if (event.kind === 'outbox.nacked') return '审核消息退回等待再次处理';
  if (event.kind === 'outbox.channel-configured') return `频道 ${payload.channel ?? event.entityId} 已就绪`;
  if (event.kind === 'outbox.channel-updated') return `频道 ${payload.channel ?? event.entityId} 的容量策略已更新`;
  return event.kind;
}

function toast(message, type = 'info') {
  const item = createElement('div', `toast${type === 'error' ? ' is-error' : ''}`, message);
  elements.toastRegion.append(item);
  window.setTimeout(() => item.remove(), 4200);
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    headers.set('x-agent-team-token', mutationToken);
  }

  const response = await fetch(path, {
    ...options,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error?.message ?? `Request failed with ${response.status}`;
    const error = new Error(message);
    error.code = body?.error?.code;
    throw error;
  }
  return body;
}

function getTask(taskId) {
  return state.snapshot?.tasks?.find((task) => task.taskId === taskId) ?? null;
}

function dependenciesReady(task) {
  const dependencies = task.dependencies ?? [];
  if (dependencies.length === 0) return true;
  const byId = new Map((state.snapshot?.tasks ?? []).map((entry) => [entry.taskId, entry]));
  return dependencies.every((taskId) => byId.get(taskId)?.state === 'completed');
}

function reviewMessages() {
  return (state.snapshot?.outbox ?? []).filter((message) => (
    message.channel === 'review' && message.state !== 'acked'
  ));
}

function setHealth(ok, message, detail) {
  elements.controlHealth.classList.toggle('is-good', ok === true);
  elements.controlHealth.classList.toggle('is-bad', ok === false);
  elements.controlHealth.querySelector(':scope > div > strong').textContent = message;
  elements.controlHealth.querySelector(':scope > div > span').textContent = detail;
}

function renderProject() {
  const context = state.snapshot?.context ?? {};
  const repoRoot = context.repoRoot ?? '';
  elements.projectName.textContent = context.repoName ?? fileName(repoRoot);
  elements.projectPath.textContent = repoRoot || 'Local SQLite authority';
  elements.projectBranch.textContent = context.branch ?? `repo ${shortId(context.repoId, 6)}`;
}

function renderMetrics() {
  const tasks = state.snapshot?.tasks ?? [];
  const verification = state.snapshot?.verify;
  const eventCount = state.snapshot?.eventHead?.seq ?? state.snapshot?.events?.length ?? 0;
  const reviewCount = reviewMessages().length;

  elements.metricQueued.textContent = tasks.filter((task) => task.state === 'queued').length;
  elements.metricRunning.textContent = tasks.filter((task) => (
    task.state === 'running' || task.state === 'waiting_children'
  )).length;
  elements.metricReview.textContent = reviewCount;
  elements.metricEvents.textContent = eventCount;
  elements.reviewNavCount.textContent = reviewCount;

  const integrityOk = verification?.integrityCheck === 'ok' && verification?.eventLog?.ok === true;
  const daemon = state.snapshot?.daemon;
  const daemonOnline = daemon?.running === true;
  elements.metricIntegrity.textContent = integrityOk ? 'verified' : 'attention';
  setHealth(
    integrityOk,
    integrityOk
      ? (daemonOnline ? '常驻调度在线' : '控制面正常')
      : '完整性需检查',
    integrityOk
      ? (daemonOnline
        ? `${daemon.concurrency} worker slots · ${daemon.activeRuns} active`
        : 'GUI mode · tasks require manual run')
      : 'Open event audit for details',
  );
}

function createAgentAvatar(agent, sizeClass = '') {
  const avatar = createElement('span', `agent-avatar ${sizeClass}`.trim(), agent.initials);
  avatar.dataset.adapter = agent.adapter;
  avatar.setAttribute('aria-hidden', 'true');
  return avatar;
}

function renderAgents() {
  const agents = agentProjection();
  const activeCount = agents.filter((agent) => agent.status === 'working').length;
  elements.agentActiveCount.textContent = `${activeCount} active`;
  elements.agentRoster.replaceChildren();

  for (const agent of agents) {
    const row = createElement('button', 'agent-row');
    row.type = 'button';
    row.dataset.status = agent.status;
    row.setAttribute('aria-label', `${agent.name}，${ADAPTER_LABELS[agent.adapter]}：${agent.headline}`);
    const copy = createElement('span', 'agent-row-copy');
    copy.append(
      createElement('strong', null, agent.name),
      createElement('span', null, `${ADAPTER_LABELS[agent.adapter]} · ${agent.headline}`),
    );
    const signal = createElement('span', 'agent-signal');
    signal.setAttribute('aria-hidden', 'true');
    row.append(createAgentAvatar(agent), copy, signal);
    row.addEventListener('click', () => {
      if (agent.current) selectTask(agent.current.taskId, 'activity');
      else {
        elements.activityPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    elements.agentRoster.append(row);
  }

  elements.workingAvatarStack.replaceChildren();
  const visibleAgents = activeCount > 0
    ? agents.filter((agent) => agent.status === 'working')
    : agents;
  for (const agent of visibleAgents) {
    elements.workingAvatarStack.append(createAgentAvatar(agent, 'is-small'));
  }

  if (activeCount > 0) {
    const active = agents.filter((agent) => agent.status === 'working');
    elements.workingBar.dataset.state = 'working';
    elements.workingTitle.textContent = active.length === 1
      ? `${active[0].name} 正在工作`
      : `${active.length} 个 Agent 正在并行工作`;
    elements.workingDetail.textContent = active
      .map((agent) => `${agent.name}/${agent.adapter}: ${agent.headline}`)
      .join(' · ');
  } else {
    const queued = agents.reduce((sum, agent) => sum + agent.queued, 0);
    const attention = agents.reduce((sum, agent) => sum + agent.failed, 0);
    elements.workingBar.dataset.state = attention > 0 ? 'attention' : 'idle';
    elements.workingTitle.textContent = attention > 0
      ? `${attention} 个任务需要处理`
      : queued > 0
        ? `团队已就绪，${queued} 个任务等待派工`
        : 'Agent 团队待命';
    elements.workingDetail.textContent = attention > 0
      ? '打开任务检查器查看错误并决定是否重试'
      : 'Codex CLI 与 Claude Code CLI 将由常驻控制器按任务自动派工';
  }
}

function buildActivityRow(event) {
  const actor = actorForEvent(event);
  const task = eventTask(event);
  const row = createElement('li', 'activity-row');
  row.dataset.kind = event.kind;

  const avatar = createElement('span', 'agent-avatar is-small', actor.initials);
  avatar.dataset.adapter = actor.type;
  avatar.setAttribute('aria-hidden', 'true');

  const copy = createElement('div', 'activity-copy');
  const meta = createElement('div', 'activity-meta');
  meta.append(
    createElement('strong', null, actor.name),
    createElement('time', null, formatDate(event.occurredAt)),
  );
  copy.append(meta, createElement('p', null, eventHeadline(event)));

  const kind = createElement('span', 'activity-kind', event.kind.replace(/^task\.|^outbox\./, ''));
  row.append(avatar, copy, kind);
  if (task) {
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.addEventListener('click', () => selectTask(task.taskId, 'activity'));
    row.addEventListener('keydown', (eventKey) => {
      if (eventKey.key === 'Enter' || eventKey.key === ' ') {
        eventKey.preventDefault();
        selectTask(task.taskId, 'activity');
      }
    });
  }
  return row;
}

function renderActivity() {
  const events = [...(state.snapshot?.events ?? [])]
    .filter((event) => event.kind !== 'task.heartbeat')
    .reverse()
    .slice(0, 18);
  elements.activityFeed.replaceChildren();
  elements.activityEmpty.hidden = events.length !== 0;
  for (const event of events) elements.activityFeed.append(buildActivityRow(event));
}

function taskMatchesFilter(task) {
  if (state.filter === 'all') return true;
  if (state.filter === 'attention') {
    return task.state === 'failed' || (task.state === 'queued' && !dependenciesReady(task));
  }
  if (state.filter === 'active') {
    return ['queued', 'running', 'waiting_children'].includes(task.state);
  }
  return true;
}

function buildTaskCard(task) {
  const payload = task.payload ?? {};
  const card = createElement('button', 'task-card');
  card.type = 'button';
  card.dataset.state = task.state;
  card.dataset.taskId = task.taskId;
  card.classList.toggle('is-selected', state.selectedTaskId === task.taskId);
  card.setAttribute('aria-pressed', state.selectedTaskId === task.taskId ? 'true' : 'false');

  const top = createElement('div', 'task-card-top');
  top.append(
    createElement('span', null, sliceKeyFor(task) || shortId(task.taskId)),
    createElement('span', null, `g${task.generation}`),
  );

  const heading = createElement('h3', null, payload.title ?? task.key ?? task.taskId);
  const description = createElement('p', null, payload.description || 'No description provided.');

  const meta = createElement('div', 'task-card-meta');
  meta.append(
    createElement('span', 'adapter-chip', payload.adapter ?? 'codex'),
    createElement('span', 'role-chip', payload.role ?? 'builder'),
  );
  const status = createElement('span', 'status-chip', titleForState(task.state));
  status.dataset.state = task.state;
  meta.append(status);
  if (parentTaskIdFor(task)) {
    meta.append(createElement('span', 'lineage-chip', `parent ${shortId(parentTaskIdFor(task), 6)}`));
  } else if (payload.executionMode === 'planner') {
    meta.append(createElement('span', 'lineage-chip', 'team root'));
  }
  if (task.state === 'queued' && !dependenciesReady(task)) {
    meta.append(createElement('span', 'status-chip', 'blocked'));
  }

  const footer = createElement('div', 'task-card-footer');
  const baseOid = payload.baseOid ?? payload.base ?? 'HEAD';
  footer.append(
    createElement('span', null, shortId(baseOid, 7)),
    createElement('span', null, formatDate(task.updatedAt)),
  );

  card.append(top, heading, description, meta, footer);
  card.addEventListener('click', () => selectTask(task.taskId));
  return card;
}

function renderTaskBoard() {
  const tasks = (state.snapshot?.tasks ?? []).filter(taskMatchesFilter);
  elements.loadingBoard.hidden = true;
  elements.taskBoard.replaceChildren();
  elements.taskBoard.hidden = tasks.length === 0;
  elements.tasksEmpty.hidden = tasks.length !== 0;

  if (tasks.length === 0) return;

  for (const lane of [
    { state: 'queued', states: ['queued'], label: '待执行' },
    { state: 'running', states: ['running', 'waiting_children'], label: '运行中' },
    { state: 'completed', states: ['completed'], label: '已完成' },
    { state: 'failed', states: ['failed'], label: '失败' },
  ]) {
    const laneTasks = tasks.filter((task) => lane.states.includes(task.state));
    const column = createElement('section', 'task-lane');
    column.dataset.state = lane.state;
    column.setAttribute('aria-label', `${lane.label}任务`);

    const header = createElement('header', 'lane-header');
    const title = createElement('div', 'lane-title');
    title.append(createElement('span', 'lane-state-mark'), createElement('span', null, lane.label));
    header.append(title, createElement('span', 'lane-count', laneTasks.length));

    const body = createElement('div', 'lane-body');
    if (laneTasks.length === 0) {
      body.append(createElement('div', 'lane-empty', '当前没有任务'));
    } else {
      for (const task of laneTasks) body.append(buildTaskCard(task));
    }
    column.append(header, body);
    elements.taskBoard.append(column);
  }
}

function dependencySummary(task, byId) {
  const dependencies = task.dependencies ?? [];
  if (dependencies.length === 0) return '无前置依赖';
  const labels = dependencies.map((taskId) => {
    const dependency = byId.get(taskId);
    if (!dependency) return shortId(taskId, 6);
    return sliceKeyFor(dependency) || roleForTask(dependency) || shortId(taskId, 6);
  });
  return `依赖 ${labels.join(' + ')}`;
}

function buildTeamNode(task, childrenByParent, byId, ancestry = new Set()) {
  const branch = createElement('div', 'team-branch');
  const node = createElement('button', 'team-node');
  const children = childrenByParent.get(task.taskId) ?? [];
  const role = roleForTask(task);
  const adapter = adapterForTask(task);
  const stateLabel = titleForState(task.state);
  node.type = 'button';
  node.dataset.state = task.state;
  node.dataset.role = role;
  node.classList.toggle('is-root', parentTaskIdFor(task) === null);
  node.classList.toggle('is-selected', state.selectedTaskId === task.taskId);
  node.setAttribute('aria-label', `${role}，${ADAPTER_LABELS[adapter]}，${stateLabel}：${taskTitle(task)}`);

  const identity = createElement('div', 'team-node-identity');
  const stateDot = createElement('span', 'team-node-state');
  stateDot.setAttribute('aria-hidden', 'true');
  identity.append(
    stateDot,
    createElement('strong', null, role),
    createElement('span', 'team-node-adapter', adapter),
    createElement('span', 'team-node-status', stateLabel),
  );
  const title = createElement('span', 'team-node-title', taskTitle(task));
  const facts = createElement('span', 'team-node-facts');
  facts.append(
    createElement('span', null, sliceKeyFor(task) || `task ${shortId(task.taskId, 6)}`),
    createElement('span', null, children.length > 0
      ? `${children.length} 个直属子任务`
      : dependencySummary(task, byId)),
  );
  node.append(identity, title, facts);
  node.addEventListener('click', () => selectTask(task.taskId));
  branch.append(node);

  if (children.length > 0 && !ancestry.has(task.taskId)) {
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(task.taskId);
    const childList = createElement('div', 'team-children');
    for (const child of children) {
      if (!nextAncestry.has(child.taskId)) {
        childList.append(buildTeamNode(child, childrenByParent, byId, nextAncestry));
      }
    }
    branch.append(childList);
  } else if (task.payload?.executionMode === 'planner' && children.length === 0) {
    branch.append(createElement('div', 'team-children-empty', '等待 Planner 生成受限子任务图'));
  }
  return branch;
}

function renderTeamMap() {
  const tasks = state.snapshot?.tasks ?? [];
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const childrenByParent = new Map();
  for (const task of tasks) {
    const parentTaskId = parentTaskIdFor(task);
    if (!parentTaskId) continue;
    const children = childrenByParent.get(parentTaskId) ?? [];
    children.push(task);
    childrenByParent.set(parentTaskId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => (
      (left.createdAt ?? 0) - (right.createdAt ?? 0)
      || left.taskId.localeCompare(right.taskId)
    ));
  }

  const roots = tasks.filter((task) => {
    const parentTaskId = parentTaskIdFor(task);
    return (
      (!parentTaskId && (task.payload?.executionMode === 'planner' || childrenByParent.has(task.taskId)))
      || (parentTaskId && !byId.has(parentTaskId))
    );
  });
  roots.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));

  elements.teamForest.replaceChildren();
  elements.teamMapPanel.hidden = roots.length === 0;
  elements.teamMapCount.textContent = `${roots.length} team${roots.length === 1 ? '' : 's'}`;
  for (const root of roots) {
    const tree = createElement('article', 'team-tree');
    tree.append(buildTeamNode(root, childrenByParent, byId));
    elements.teamForest.append(tree);
  }
}

function appendDetail(detailGrid, label, value) {
  const wrapper = document.createElement('div');
  wrapper.append(createElement('dt', null, label), createElement('dd', null, value ?? 'none'));
  detailGrid.append(wrapper);
}

function renderList(values, className, emptyText) {
  const list = createElement('ul', className);
  if (!values?.length) {
    list.append(createElement('li', null, emptyText));
    return list;
  }
  for (const value of values) list.append(createElement('li', null, value));
  return list;
}

function buildInspectorSection(title, content) {
  const section = createElement('section', 'inspector-section');
  section.append(createElement('h3', null, title), content);
  return section;
}

function eventsForTask(taskId) {
  return [...(state.snapshot?.events ?? [])]
    .filter((event) => (
      (event.entityType === 'task' && event.entityId === taskId)
      || event.payload?.taskId === taskId
    ))
    .reverse();
}

function runsForTask(taskId) {
  return [...(state.snapshot?.runs ?? [])]
    .filter((run) => run.taskId === taskId)
    .reverse();
}

function buildInspectorTabs() {
  const tabs = createElement('div', 'inspector-tabs');
  tabs.setAttribute('role', 'tablist');
  for (const [mode, label] of [
    ['summary', '摘要'],
    ['activity', '动态'],
    ['raw', '原始记录'],
  ]) {
    const button = createElement('button', null, label);
    button.type = 'button';
    button.dataset.inspectorMode = mode;
    button.classList.toggle('is-active', state.inspectorMode === mode);
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', state.inspectorMode === mode ? 'true' : 'false');
    button.addEventListener('click', () => {
      state.inspectorMode = mode;
      renderInspector();
    });
    tabs.append(button);
  }
  return tabs;
}

function buildTaskReference(task, fallbackId) {
  if (!task) {
    return createElement('span', 'task-reference is-missing', shortId(fallbackId, 12));
  }
  const button = createElement('button', 'task-reference');
  button.type = 'button';
  const main = createElement('span', 'task-reference-main');
  main.append(
    createElement('strong', null, sliceKeyFor(task) || roleForTask(task)),
    createElement('span', null, taskTitle(task)),
  );
  const stateLabel = createElement('span', 'task-reference-state', titleForState(task.state));
  stateLabel.dataset.state = task.state;
  button.append(main, stateLabel);
  button.addEventListener('click', () => selectTask(task.taskId));
  return button;
}

function buildLineageSummary(task) {
  const tasks = state.snapshot?.tasks ?? [];
  const parentTaskId = parentTaskIdFor(task);
  const parent = parentTaskId ? getTask(parentTaskId) : null;
  const children = tasks.filter((candidate) => parentTaskIdFor(candidate) === task.taskId);
  if (!parentTaskId && children.length === 0 && !sliceKeyFor(task) && task.payload?.executionMode !== 'planner') {
    return null;
  }

  const wrapper = createElement('div', 'lineage-summary');
  if (parentTaskId) {
    const parentRow = createElement('div', 'lineage-row');
    parentRow.append(createElement('span', 'lineage-label', '父任务'), buildTaskReference(parent, parentTaskId));
    wrapper.append(parentRow);
  }
  if (sliceKeyFor(task)) {
    const sliceRow = createElement('div', 'lineage-row');
    sliceRow.append(
      createElement('span', 'lineage-label', 'Slice key'),
      createElement('code', 'lineage-slice-key', sliceKeyFor(task)),
    );
    wrapper.append(sliceRow);
  }

  const childrenRow = createElement('div', 'lineage-row is-children');
  childrenRow.append(createElement('span', 'lineage-label', '直属子任务'));
  const childList = createElement('div', 'task-reference-list');
  if (children.length === 0) {
    childList.append(createElement(
      'span',
      'lineage-empty',
      task.payload?.executionMode === 'planner' ? 'Planner 尚未生成子任务' : 'none',
    ));
  } else {
    for (const child of children) childList.append(buildTaskReference(child, child.taskId));
  }
  childrenRow.append(childList);
  wrapper.append(childrenRow);
  return wrapper;
}

function buildInspectorSummary(task) {
  const payload = task.payload ?? {};
  const fragment = document.createDocumentFragment();
  const controlDetails = createElement('dl', 'detail-grid');
  appendDetail(controlDetails, 'State', titleForState(task.state));
  appendDetail(controlDetails, 'Generation', task.generation);
  appendDetail(controlDetails, 'Worker', task.worker);
  appendDetail(controlDetails, 'Lease expires', task.claimExpiresAt ? formatDate(task.claimExpiresAt) : 'not leased');
  appendDetail(controlDetails, 'Idempotency key', task.key);
  appendDetail(controlDetails, 'Channel', payload.channel ?? 'review');
  fragment.append(buildInspectorSection('控制面', controlDetails));

  const lineage = buildLineageSummary(task);
  if (lineage) fragment.append(buildInspectorSection('Agent lineage', lineage));

  const gitDetails = createElement('dl', 'detail-grid');
  appendDetail(gitDetails, 'Base OID', payload.baseOid ?? payload.base ?? 'HEAD');
  appendDetail(gitDetails, 'Candidate OID', task.result?.candidateOid ?? 'not produced');
  appendDetail(gitDetails, 'Branch', task.result?.branchName ?? 'not prepared');
  appendDetail(gitDetails, 'Adapter', task.result?.adapter ?? payload.adapter ?? 'codex');
  fragment.append(buildInspectorSection('Git 投影', gitDetails));

  if (task.result?.worktreePath) {
    fragment.append(buildInspectorSection(
      'Worktree',
      createElement('pre', 'code-block', task.result.worktreePath),
    ));
  }

  fragment.append(buildInspectorSection(
    '依赖',
    renderList(task.dependencies ?? [], 'dependency-list', 'none'),
  ));
  fragment.append(buildInspectorSection(
    '允许范围',
    renderList(payload.scope ?? [], 'scope-list', 'repository worktree'),
  ));

  const terminalData = task.error ?? task.result?.finalMessage ?? task.result ?? null;
  if (terminalData) {
    const content = typeof terminalData === 'string'
      ? terminalData
      : JSON.stringify(terminalData, null, 2);
    fragment.append(buildInspectorSection('最近结果', createElement('pre', 'code-block', content)));
  }
  return fragment;
}

function buildInspectorActivity(task) {
  const events = eventsForTask(task.taskId);
  const runs = runsForTask(task.taskId);
  const wrapper = createElement('section', 'inspector-section inspector-activity');
  wrapper.append(createElement('h3', null, 'Agent activity'));

  if (runs.length > 0) {
    const runStrip = createElement('div', 'run-strip');
    for (const run of runs) {
      const item = createElement('div', 'run-row');
      item.dataset.status = run.status;
      item.append(
        createElement('span', 'run-status-dot'),
        createElement('strong', null, run.worker),
        createElement('span', null, run.status),
        createElement('time', null, formatDuration(run.startedAt, run.finishedAt ?? Date.now())),
      );
      runStrip.append(item);
    }
    wrapper.append(runStrip);
  }

  if (events.length === 0) {
    wrapper.append(createElement('p', 'inspector-placeholder', '这个任务还没有控制面事件。'));
    return wrapper;
  }
  const list = createElement('ol', 'activity-feed is-inspector');
  for (const event of events) list.append(buildActivityRow(event));
  wrapper.append(list);
  return wrapper;
}

function buildInspectorRaw(task) {
  const payload = {
    events: eventsForTask(task.taskId),
    runs: runsForTask(task.taskId),
    task,
  };
  return buildInspectorSection(
    '可验证原始投影',
    createElement('pre', 'code-block raw-record', JSON.stringify(payload, null, 2)),
  );
}

function renderInspector() {
  const task = getTask(state.selectedTaskId);
  elements.emptyInspector.hidden = Boolean(task);
  elements.inspectorContent.hidden = !task;
  elements.inspector.classList.toggle('is-open', Boolean(task));
  elements.inspectorContent.replaceChildren();
  if (!task) return;

  const payload = task.payload ?? {};
  const agent = rosterEntryForTask(task);
  const adapter = adapterForTask(task);
  const panel = createElement('div', 'inspector-panel');
  const header = createElement('header', 'inspector-header');

  const headerTop = createElement('div', 'task-card-top');
  headerTop.append(
    createElement('span', null, `TASK ${shortId(task.taskId)}`),
    createElement('span', 'status-chip', titleForState(task.state)),
  );
  headerTop.lastChild.dataset.state = task.state;

  header.append(
    headerTop,
    createElement('h2', null, payload.title ?? task.key),
    createElement('p', null, payload.description || 'No description provided.'),
  );

  const identity = createElement('div', 'inspector-agent');
  const identityCopy = createElement('div');
  identityCopy.append(
    createElement('strong', null, task.worker ?? agent.name),
    createElement('span', null, `${agent.name} · ${ADAPTER_LABELS[adapter]} · ${payload.channel ?? 'review'}`),
  );
  identity.append(createAgentAvatar({ ...agent, adapter }), identityCopy);
  header.append(identity);

  const badges = createElement('div', 'task-card-meta');
  badges.append(
    createElement('span', 'adapter-chip', payload.adapter ?? 'codex'),
    createElement('span', 'role-chip', payload.role ?? 'builder'),
    createElement('span', 'role-chip', `generation ${task.generation}`),
  );
  if (sliceKeyFor(task)) badges.append(createElement('span', 'lineage-chip', sliceKeyFor(task)));
  if (parentTaskIdFor(task)) {
    badges.append(createElement('span', 'lineage-chip', `parent ${shortId(parentTaskIdFor(task), 6)}`));
  }
  header.append(badges);

  const actions = createElement('div', 'inspector-actions');
  if (task.state === 'queued') {
    const daemonOnline = state.snapshot?.daemon?.running === true;
    const run = createElement(
      'button',
      'button button-primary',
      daemonOnline ? '等待常驻调度' : '立即启动',
    );
    run.type = 'button';
    run.disabled = daemonOnline || !dependenciesReady(task);
    run.title = daemonOnline
      ? '常驻调度器会在 worker 槽位可用时自动接手'
      : (run.disabled ? '依赖任务尚未完成' : '在受控 worktree 中启动任务');
    run.addEventListener('click', () => runTask(task));
    actions.append(run);
  }
  if (task.state === 'failed') {
    const retry = createElement('button', 'button button-primary', '重试任务');
    retry.type = 'button';
    retry.addEventListener('click', () => retryTask(task));
    actions.append(retry);
  }
  const close = createElement('button', 'button button-secondary', '关闭');
  close.type = 'button';
  close.addEventListener('click', clearSelection);
  actions.append(close);
  header.append(actions);
  panel.append(header, buildInspectorTabs());
  if (state.inspectorMode === 'activity') panel.append(buildInspectorActivity(task));
  else if (state.inspectorMode === 'raw') panel.append(buildInspectorRaw(task));
  else panel.append(buildInspectorSummary(task));

  elements.inspectorContent.append(panel);
}

function renderChannels() {
  const channels = state.snapshot?.channels ?? [];
  elements.channelGrid.replaceChildren();
  for (const channel of channels) {
    const card = createElement('article', 'channel-card');
    const full = channel.pendingDepth >= channel.capacity;
    card.classList.toggle('is-full', full);

    const copy = document.createElement('div');
    copy.append(
      createElement('strong', null, channel.channel),
      createElement('span', null, full ? 'backpressure active' : 'accepting messages'),
    );
    card.append(copy, createElement('div', 'channel-depth', `${channel.pendingDepth}/${channel.capacity}`));
    elements.channelGrid.append(card);
  }
}

function renderReview() {
  const messages = reviewMessages();
  elements.reviewList.replaceChildren();
  elements.reviewEmpty.hidden = messages.length !== 0;

  for (const message of messages) {
    const payload = message.payload ?? {};
    const item = createElement('button', 'review-item');
    item.type = 'button';
    const copy = document.createElement('div');
    copy.append(
      createElement('h3', null, getTask(payload.taskId)?.payload?.title ?? `Candidate ${shortId(message.messageId)}`),
      createElement('p', null, `${payload.adapter ?? 'agent'} | ${payload.branchName ?? 'managed branch'} | ${message.state}`),
    );
    item.append(copy, createElement('span', 'review-oid', payload.candidateOid ?? message.messageId));
    item.addEventListener('click', () => {
      if (payload.taskId) selectTask(payload.taskId);
    });
    elements.reviewList.append(item);
  }
}

function renderIntegrity() {
  const verify = state.snapshot?.verify;
  const ok = verify?.integrityCheck === 'ok' && verify?.eventLog?.ok === true;
  elements.integrityBanner.classList.toggle('is-good', ok);
  elements.integrityBanner.classList.toggle('is-bad', verify && !ok);
  elements.integrityBanner.querySelector('.integrity-symbol').textContent = ok ? 'OK' : 'ERR';
  elements.integrityBanner.querySelector('strong').textContent = ok
    ? '事件链完整'
    : '事件链验证失败';
  elements.integrityBanner.querySelector('p').textContent = ok
    ? `${verify.eventLog.eventCount ?? 0} events verified with signed head metadata.`
    : (verify?.eventLog?.reason ?? `SQLite integrity: ${verify?.integrityCheck ?? 'unknown'}`);
}

function renderEvents() {
  const events = [...(state.snapshot?.events ?? [])].reverse();
  elements.eventTimeline.replaceChildren();
  for (const event of events) {
    const row = createElement('li', 'event-row');
    row.append(
      createElement('span', 'event-seq', `#${event.seq}`),
      createElement('span', 'event-kind', event.kind),
      createElement('span', 'event-entity', `${event.entityType}:${event.entityId}`),
      createElement('time', 'event-time', formatDate(event.occurredAt)),
    );
    elements.eventTimeline.append(row);
  }
}

function renderBrainRoles() {
  const projections = BRAIN_ROLE_ORDER
    .map((role) => roleProjection(role))
    .filter(({ binding, loadout }) => Boolean(binding || loadout));

  elements.brainRoleGrid.replaceChildren();
  elements.brainRolesEmpty.hidden = projections.length !== 0;
  if (projections.length === 0) return;

  for (const projection of projections) {
    const assetCount = Array.isArray(projection.loadout?.entries)
      ? projection.loadout.entries.length
      : 0;
    const card = createElement('article', 'brain-card brain-role-card');
    const titleRow = createElement('div', 'brain-card-header');
    titleRow.append(
      createElement('span', 'brain-badge', BRAIN_ROLE_LABELS[projection.role] ?? projection.role),
      createElement('span', 'brain-card-code', assetCount > 0 ? `${assetCount} assets` : 'bound'),
    );

    const heading = createElement(
      'h4',
      null,
      compactText(
        projection.loadout?.loadoutKey
        ?? projection.binding?.loadoutId
        ?? `${projection.role} loadout`,
        120,
      ),
    );
    const body = createElement(
      'p',
      'brain-card-copy',
      projection.loadout
        ? loadoutEntrySummary(projection.loadout)
        : '当前角色已绑定到只读 loadout 投影。详细写入由控制器或 CLI 管理。',
    );

    card.append(titleRow, heading, body);
    appendFactList(card, [
      ['Bound at', projection.binding?.boundAt ? formatDate(projection.binding.boundAt) : ''],
    ]);
    elements.brainRoleGrid.append(card);
  }
}

function renderBrainMemory() {
  const memoryAssets = projectAssets().filter((asset) => assetKind(asset) === 'memory');
  elements.brainMemoryGrid.replaceChildren();
  elements.brainMemoryEmpty.hidden = memoryAssets.length !== 0;
  if (memoryAssets.length === 0) return;

  for (const asset of memoryAssets) {
    const card = createElement('article', 'brain-card brain-memory-card');
    const titleRow = createElement('div', 'brain-card-header');
    titleRow.append(
      createElement('span', 'brain-badge is-memory', 'Memory'),
      createElement('span', 'brain-card-code', shortHash(asset?.assetId, 14)),
    );
    card.append(
      titleRow,
      createElement('h4', null, assetTitle(asset)),
    );
    appendFactList(card, [
      ['Layer', assetLayer(asset) || 'default'],
      ['Revision', assetRevision(asset) || 'current'],
      ['Hash', shortHash(assetHash(asset), 16)],
    ]);
    card.append(createElement('p', 'brain-card-copy', assetPreview(asset) || '控制器维护的记忆资产元数据。'));
    elements.brainMemoryGrid.append(card);
  }
}

function renderBrainAssets() {
  const assets = projectAssets();
  elements.brainAssetGroups.replaceChildren();

  for (const kind of BRAIN_KIND_ORDER) {
    const groupAssets = assets.filter((asset) => assetKind(asset) === kind);
    const section = createElement('section', 'brain-kind-section');
    const header = createElement('div', 'brain-kind-header');
    header.append(
      createElement('div', null, BRAIN_KIND_LABELS[kind] ?? kind),
      createElement('span', 'brain-kind-count', String(groupAssets.length)),
    );
    section.append(header);

    if (groupAssets.length === 0) {
      section.append(createElement(
        'p',
        'brain-kind-empty',
        `${BRAIN_KIND_LABELS[kind] ?? kind} 资产还没有写入。新增内容会由控制器或 CLI 管理并自动投影到这里。`,
      ));
      elements.brainAssetGroups.append(section);
      continue;
    }

    const grid = createElement('div', 'brain-kind-grid');
    for (const asset of groupAssets) {
      const card = createElement('article', 'brain-card brain-asset-card');
      const titleRow = createElement('div', 'brain-card-header');
      titleRow.append(
        createElement('span', `brain-badge is-${kind}`, BRAIN_KIND_LABELS[kind] ?? kind),
        createElement('span', 'brain-card-code', shortHash(asset?.assetId, 14)),
      );
      card.append(titleRow, createElement('h4', null, assetTitle(asset)));
      const preview = assetPreview(asset);
      card.append(createElement(
        'p',
        'brain-card-copy',
        preview || '该资产当前只暴露短摘要；完整正文仍由控制器或 CLI 写入路径管理。',
      ));
      appendFactList(card, [
        ['Layer', assetLayer(asset)],
        ['Revision', assetRevision(asset)],
        ['Hash', shortHash(assetHash(asset), 16)],
        ['Key', compactText(asset?.assetKey, 80)],
      ]);
      grid.append(card);
    }
    section.append(grid);
    elements.brainAssetGroups.append(section);
  }
}

function renderBrain() {
  renderBrainRoles();
  renderBrainMemory();
  renderBrainAssets();
}

function renderAll() {
  renderProject();
  renderMetrics();
  renderAgents();
  renderActivity();
  renderTeamMap();
  renderTaskBoard();
  renderInspector();
  renderChannels();
  renderReview();
  renderIntegrity();
  renderEvents();
  renderBrain();
}

function selectTask(taskId, inspectorMode = 'summary') {
  state.selectedTaskId = taskId;
  state.inspectorMode = inspectorMode;
  renderTeamMap();
  renderTaskBoard();
  renderInspector();
}

function clearSelection() {
  state.selectedTaskId = null;
  state.inspectorMode = 'summary';
  renderTeamMap();
  renderTaskBoard();
  renderInspector();
}

async function refreshSnapshot({ quiet = false } = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  elements.refreshButton.disabled = true;
  if (!quiet) elements.refreshButton.textContent = '刷新中';
  try {
    state.snapshot = await request('/api/snapshot?taskLimit=250&outboxLimit=100&eventLimit=120');
    state.loading = false;
    renderAll();
  } catch (error) {
    setHealth(false, '无法连接控制面', error.message);
    if (!quiet) toast(error.message, 'error');
  } finally {
    state.refreshing = false;
    elements.refreshButton.disabled = false;
    elements.refreshButton.textContent = '刷新';
  }
}

async function runTask(task) {
  const adapter = task.payload?.adapter ?? 'codex';
  try {
    await request(`/api/tasks/${encodeURIComponent(task.taskId)}/run`, {
      body: {
        leaseMs: 60_000,
        worker: `gui-${adapter}-1`,
      },
      method: 'POST',
    });
    toast(`${adapter} worker 已启动`);
    await refreshSnapshot({ quiet: true });
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function retryTask(task) {
  try {
    await request(`/api/tasks/${encodeURIComponent(task.taskId)}/retry`, {
      body: {
        expectedGeneration: task.generation,
        reason: 'Retried from local GUI',
      },
      method: 'POST',
    });
    toast('任务已重新进入队列');
    await refreshSnapshot({ quiet: true });
  } catch (error) {
    toast(error.message, 'error');
  }
}

function openTaskDialog() {
  elements.taskForm.reset();
  elements.taskForm.elements.base.value = state.snapshot?.context?.branch ?? 'HEAD';
  elements.taskForm.elements.channel.value = 'review';
  elements.taskForm.elements.idempotencyKey.value = `gui-${crypto.randomUUID().slice(0, 12)}`;
  elements.taskForm.elements.builderAdapter.value = DEFAULT_TEAM_ADAPTERS.builder;
  elements.taskForm.elements.researcherAdapter.value = DEFAULT_TEAM_ADAPTERS.researcher;
  elements.taskForm.elements.testAdapter.value = DEFAULT_TEAM_ADAPTERS.test;
  elements.taskForm.elements.reviewerAdapter.value = DEFAULT_TEAM_ADAPTERS.reviewer;
  elements.taskForm.elements.verifierAdapter.value = DEFAULT_TEAM_ADAPTERS.verifier;
  syncTaskExecutionMode();
  elements.dialogError.hidden = true;
  elements.taskDialog.showModal();
  elements.taskForm.elements.title.focus();
}

function closeTaskDialog() {
  elements.taskDialog.close();
}

function syncTaskExecutionMode() {
  const mode = elements.taskForm.elements.executionMode.value ?? 'single';
  const teamMode = mode === 'team';
  const role = elements.taskForm.elements.role;
  elements.taskRoleField.hidden = teamMode;
  elements.teamRouting.hidden = !teamMode;
  role.disabled = teamMode;
  elements.taskAdapterLabel.textContent = teamMode ? 'Planner Agent' : 'Agent';
  elements.createTaskSubmit.textContent = teamMode ? '创建团队任务' : '写入队列';
}

async function submitTask(event) {
  event.preventDefault();
  const data = new FormData(elements.taskForm);
  const title = String(data.get('title') ?? '').trim();
  const description = String(data.get('description') ?? '').trim();
  const dependencies = splitList(data.get('dependencies'));
  const scope = splitList(data.get('scope'));
  const key = String(data.get('idempotencyKey') ?? '').trim();
  const teamMode = data.get('executionMode') === 'team';
  const payload = {
    adapter: String(data.get('adapter') ?? 'codex'),
    base: String(data.get('base') ?? 'HEAD').trim() || 'HEAD',
    channel: String(data.get('channel') ?? 'review').trim() || 'review',
    dependencies,
    description,
    role: teamMode ? 'planner' : String(data.get('role') ?? 'builder'),
    scope,
    title,
  };
  if (teamMode) {
    payload.executionMode = 'planner';
    payload.teamAdapters = {
      builder: String(data.get('builderAdapter') ?? DEFAULT_TEAM_ADAPTERS.builder),
      researcher: String(data.get('researcherAdapter') ?? DEFAULT_TEAM_ADAPTERS.researcher),
      test: String(data.get('testAdapter') ?? DEFAULT_TEAM_ADAPTERS.test),
      reviewer: String(data.get('reviewerAdapter') ?? DEFAULT_TEAM_ADAPTERS.reviewer),
      verifier: String(data.get('verifierAdapter') ?? DEFAULT_TEAM_ADAPTERS.verifier),
    };
  }

  elements.createTaskSubmit.disabled = true;
  elements.createTaskSubmit.textContent = teamMode ? '正在组建团队' : '写入中';
  elements.dialogError.hidden = true;

  try {
    const result = await request('/api/tasks', {
      body: { dependencies, key, payload },
      method: 'POST',
    });
    closeTaskDialog();
    toast(result.status === 'replayed'
      ? '已安全重放现有任务'
      : teamMode
        ? '团队任务已交给 Planner'
        : '任务已写入队列');
    state.selectedTaskId = result.task?.taskId ?? null;
    await refreshSnapshot({ quiet: true });
  } catch (error) {
    elements.dialogError.textContent = error.message;
    elements.dialogError.hidden = false;
  } finally {
    elements.createTaskSubmit.disabled = false;
    syncTaskExecutionMode();
  }
}

function setView(view) {
  state.view = view;
  for (const button of document.querySelectorAll('[data-view]')) {
    const active = button.dataset.view === view;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  for (const panel of document.querySelectorAll('[data-view-panel]')) {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle('is-active', active);
  }
  history.replaceState(null, '', `#${view}`);
}

function applyTheme() {
  const root = document.documentElement;
  if (state.theme === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = state.theme;
  elements.themeLabel.textContent = ({ auto: '自动', light: '浅色', dark: '深色' })[state.theme];
  localStorage.setItem('agent-team-theme', state.theme);
}

function cycleTheme() {
  const themes = ['auto', 'light', 'dark'];
  state.theme = themes[(themes.indexOf(state.theme) + 1) % themes.length];
  applyTheme();
}

function bindEvents() {
  elements.newTaskButton.addEventListener('click', openTaskDialog);
  elements.refreshButton.addEventListener('click', () => refreshSnapshot());
  elements.verifyButton.addEventListener('click', () => refreshSnapshot());
  elements.closeTaskDialog.addEventListener('click', closeTaskDialog);
  document.querySelector('#cancel-task-dialog').addEventListener('click', closeTaskDialog);
  elements.taskForm.addEventListener('submit', submitTask);
  for (const input of elements.taskForm.elements.executionMode) {
    input.addEventListener('change', syncTaskExecutionMode);
  }
  elements.themeToggle.addEventListener('click', cycleTheme);
  elements.workingBar.addEventListener('click', () => {
    setView('tasks');
    elements.activityPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  for (const button of document.querySelectorAll('[data-open-new-task]')) {
    button.addEventListener('click', openTaskDialog);
  }
  for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => setView(button.dataset.view));
  }
  for (const button of document.querySelectorAll('[data-filter]')) {
    button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      for (const item of document.querySelectorAll('[data-filter]')) {
        item.classList.toggle('is-active', item === button);
      }
      renderTaskBoard();
    });
  }

  elements.taskDialog.addEventListener('click', (event) => {
    if (event.target === elements.taskDialog) closeTaskDialog();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !elements.taskDialog.open && state.selectedTaskId) {
      clearSelection();
    }
  });
}

function initialize() {
  applyTheme();
  bindEvents();
  const initialView = location.hash.slice(1);
  if (['tasks', 'review', 'events', 'brain'].includes(initialView)) setView(initialView);
  refreshSnapshot();
  window.setInterval(() => refreshSnapshot({ quiet: true }), 2_000);
}

initialize();
