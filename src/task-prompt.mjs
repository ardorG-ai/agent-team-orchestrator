function section(title, value) {
  if (value === undefined || value === null || value === '') return '';
  return `\n## ${title}\n${value}\n`;
}

export function buildTaskPrompt(task, claim, context = {}) {
  const payload = task.payload ?? task.spec ?? {};
  const scope = Array.isArray(payload.scope) && payload.scope.length
    ? payload.scope.map((path) => `- ${path}`).join('\n')
    : '- repository worktree only';
  const taskDependencies = task.dependencies ?? payload.dependencies;
  const dependencies = Array.isArray(taskDependencies) && taskDependencies.length
    ? taskDependencies.map((id) => `- ${id}`).join('\n')
    : '- none';

  return `You are the ${payload.role ?? 'builder'} for one fenced work unit.

Task ID: ${task.id ?? task.taskId}
Lease generation: ${claim.generation}
Repository: ${context.repoRoot ?? 'current worktree'}
Base commit: ${context.baseOid ?? 'recorded by controller'}

## Objective
${payload.title ?? 'Complete the assigned task'}
${section('Description', payload.description ?? '')}
## Allowed scope
${scope}

## Dependencies
${dependencies}

## Required behavior
- Work only inside this Git worktree and the allowed scope.
- Do not merge, rebase, force-update refs, delete branches, or delete worktrees.
- Preserve unrelated user changes.
- Run the relevant tests and static checks.
- Commit the finished change before returning. The controller accepts only a clean worktree and records the exact candidate commit OID.
- If blocked, explain the blocker without fabricating success.

## Final response
Summarize changed files, verification performed, remaining risks, and the resulting commit OID.
`;
}
