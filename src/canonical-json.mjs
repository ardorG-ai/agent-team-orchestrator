import { createHash } from 'node:crypto';

function normalizeJsonValue(value, seen) {
  if (value === null) {
    return null;
  }

  const type = typeof value;

  if (type === 'string' || type === 'boolean') {
    return value;
  }

  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON only supports finite numbers');
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (type === 'bigint') {
    throw new TypeError('Canonical JSON does not support bigint values');
  }

  if (type === 'undefined' || type === 'function' || type === 'symbol') {
    return undefined;
  }

  if (type !== 'object') {
    throw new TypeError(`Unsupported canonical JSON value type: ${type}`);
  }

  if (seen.has(value)) {
    throw new TypeError('Canonical JSON does not support cyclic structures');
  }

  const toJson = value.toJSON;
  if (typeof toJson === 'function') {
    return normalizeJsonValue(toJson.call(value), seen);
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => {
        const normalized = normalizeJsonValue(entry, seen);
        return normalized === undefined ? null : normalized;
      });
    }

    const normalizedObject = {};
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      const normalized = normalizeJsonValue(value[key], seen);
      if (normalized !== undefined) {
        normalizedObject[key] = normalized;
      }
    }
    return normalizedObject;
  } finally {
    seen.delete(value);
  }
}

export function normalizeCanonicalJson(value) {
  return normalizeJsonValue(value, new Set());
}

export function canonicalStringify(value) {
  return JSON.stringify(normalizeCanonicalJson(value));
}

export function canonicalBytes(value) {
  return Buffer.from(canonicalStringify(value), 'utf8');
}

export function canonicalHash(value) {
  return createHash('sha256').update(canonicalBytes(value)).digest('hex');
}

export function canonicalParse(text) {
  return normalizeCanonicalJson(JSON.parse(text));
}
