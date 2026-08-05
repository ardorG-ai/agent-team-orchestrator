import { AgentTeamError } from './errors.mjs';

export function parseArgv(argv) {
  const positionals = [];
  const flags = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }

    const equals = value.indexOf('=');
    const name = value.slice(2, equals === -1 ? undefined : equals);
    if (!name) throw new AgentTeamError('invalid_argument', 'empty flag name');
    const explicit = equals === -1 ? undefined : value.slice(equals + 1);
    const next = argv[index + 1];
    const parsed = explicit ?? (next !== undefined && !next.startsWith('--') ? argv[++index] : true);
    const existing = flags.get(name);
    if (existing === undefined) flags.set(name, parsed);
    else if (Array.isArray(existing)) existing.push(parsed);
    else flags.set(name, [existing, parsed]);
  }

  return { positionals, flags };
}

export function flag(parsed, name, fallback = undefined) {
  return parsed.flags.has(name) ? parsed.flags.get(name) : fallback;
}

export function requiredFlag(parsed, name) {
  const value = flag(parsed, name);
  if (value === undefined || value === true || value === '') {
    throw new AgentTeamError('missing_argument', `--${name} is required`);
  }
  return String(value);
}

export function integerFlag(parsed, name, fallback, options = {}) {
  const raw = flag(parsed, name, fallback);
  const value = Number(raw);
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AgentTeamError('invalid_argument', `--${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function listFlag(parsed, name) {
  const raw = flag(parsed, name);
  if (raw === undefined || raw === true || raw === '') return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.flatMap((value) => String(value).split(',')).map((value) => value.trim()).filter(Boolean);
}

export function booleanFlag(parsed, name) {
  const raw = flag(parsed, name, false);
  if (raw === true) return true;
  if (raw === false) return false;
  if (['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase())) return false;
  throw new AgentTeamError('invalid_argument', `--${name} must be a boolean`);
}
