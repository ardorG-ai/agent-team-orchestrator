export class AgentTeamError extends Error {
  constructor(code, message, details = undefined, exitCode = 1) {
    super(message);
    this.name = 'AgentTeamError';
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

export function invariant(condition, code, message, details = undefined) {
  if (!condition) throw new AgentTeamError(code, message, details);
}

export function errorPayload(error) {
  if (error instanceof AgentTeamError) {
    return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
  }
  return { ok: false, error: { code: 'internal_error', message: error instanceof Error ? error.message : String(error) } };
}
