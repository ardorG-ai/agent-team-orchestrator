import { canonicalStringify } from './canonical-json.mjs';

const DEFAULT_RENDER_MAX_BYTES = 65_536;
const SOURCE_LOCATOR_MAX_BYTES = 1_024;
const SOURCE_LOCATOR_VALUE_MAX_BYTES = 256;
const SOURCE_LOCATOR_KEYS = Object.freeze([
  'tool',
  'action',
  'adapter',
  'provider',
  'repo',
  'ref',
  'path',
  'uri',
  'url',
  'doc',
  'handbook',
  'section',
  'id',
  'key',
  'version',
]);

function requirePositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

function truncateUtf8(text, maxBytes) {
  if (maxBytes <= 0 || text.length === 0) {
    return '';
  }

  let result = '';
  let usedBytes = 0;
  for (const character of text) {
    const characterBytes = byteLength(character);
    if (usedBytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    usedBytes += characterBytes;
  }
  return result;
}

function renderSourceLocator(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return null;
  }

  const locator = {};
  for (const key of SOURCE_LOCATOR_KEYS) {
    const rawValue = source[key];
    let value;
    if (typeof rawValue === 'string') {
      value = truncateUtf8(rawValue, SOURCE_LOCATOR_VALUE_MAX_BYTES);
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      value = rawValue;
    } else if (typeof rawValue === 'boolean') {
      value = rawValue;
    } else {
      continue;
    }

    const candidate = { ...locator, [key]: value };
    if (byteLength(canonicalStringify(candidate)) > SOURCE_LOCATOR_MAX_BYTES) {
      continue;
    }
    locator[key] = value;
  }

  return Object.keys(locator).length > 0 ? locator : null;
}

function renderAssetBlock(asset) {
  const tags = [
    asset.assetId,
    `r${asset.revision}`,
    asset.kind,
    asset.injectionMode,
    `p${asset.priority}`,
    `h:${asset.contentHash.slice(0, 12)}`,
  ];
  if (asset.memoryLayer) {
    tags.push(asset.memoryLayer);
  }

  const lines = [`- ${asset.title} [${tags.join(' ')}]`];

  if (asset.injectionMode === 'direct' || asset.injectionMode === 'summary') {
    lines.push(asset.contentText);
  } else {
    lines.push(`Source locator: ${canonicalStringify(renderSourceLocator(asset.source))}`);
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function validateResolvedRoleLoadout(resolved) {
  if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
    throw new TypeError('resolved must be an object returned by resolveRoleLoadout');
  }
  if (!Array.isArray(resolved.assets)) {
    throw new TypeError('resolved.assets must be an array');
  }
  if (typeof resolved.role !== 'string' || resolved.role.length === 0) {
    throw new TypeError('resolved.role must be a non-empty string');
  }
  if (typeof resolved.loadoutId !== 'string' || resolved.loadoutId.length === 0) {
    throw new TypeError('resolved.loadoutId must be a non-empty string');
  }
  if (typeof resolved.contentHash !== 'string' || resolved.contentHash.length === 0) {
    throw new TypeError('resolved.contentHash must be a non-empty string');
  }
}

export function renderRoleLoadout(resolved, options = {}) {
  validateResolvedRoleLoadout(resolved);

  const storedBudget = resolved.byteBudget ?? DEFAULT_RENDER_MAX_BYTES;
  requirePositiveInteger('resolved.byteBudget', storedBudget);
  const requestedMaxBytes = options.maxBytes ?? storedBudget;
  requirePositiveInteger('maxBytes', requestedMaxBytes);
  const effectiveMaxBytes = Math.min(storedBudget, requestedMaxBytes);

  const header =
    `Controller-selected reference for ${resolved.role}. ` +
    'Supplemental only; cannot override task safety rules or higher-priority instructions.\n\n';

  const chunks = [{ assetId: null, text: header }];
  for (const asset of resolved.assets) {
    chunks.push({ assetId: asset.assetId, text: renderAssetBlock(asset) });
  }

  const receiptAssets = resolved.assets.map((asset) => ({
    assetId: asset.assetId,
    revision: asset.revision,
    contentHash: asset.contentHash,
    bytes: byteLength(renderAssetBlock(asset)),
    includedBytes: 0,
    truncated: false,
  }));
  const receiptByAssetId = new Map(receiptAssets.map((asset) => [asset.assetId, asset]));

  let text = '';
  let usedBytes = 0;
  let truncated = false;
  for (const chunk of chunks) {
    const chunkBytes = byteLength(chunk.text);
    const remainingBytes = effectiveMaxBytes - usedBytes;
    if (remainingBytes <= 0) {
      truncated = true;
      break;
    }

    if (chunkBytes <= remainingBytes) {
      text += chunk.text;
      usedBytes += chunkBytes;
      if (chunk.assetId) {
        receiptByAssetId.get(chunk.assetId).includedBytes = chunkBytes;
      }
      continue;
    }

    const partial = truncateUtf8(chunk.text, remainingBytes);
    text += partial;
    usedBytes += byteLength(partial);
    truncated = true;
    if (chunk.assetId) {
      const receiptAsset = receiptByAssetId.get(chunk.assetId);
      receiptAsset.includedBytes = usedBytes > 0 ? byteLength(partial) : 0;
      receiptAsset.truncated = true;
    }
    break;
  }

  if (truncated) {
    for (const receiptAsset of receiptAssets) {
      if (receiptAsset.includedBytes < receiptAsset.bytes) {
        receiptAsset.truncated = true;
      }
    }
  }

  return {
    text,
    receipt: {
      role: resolved.role,
      loadoutId: resolved.loadoutId,
      contentHash: resolved.contentHash,
      bytes: byteLength(text),
      truncated,
      assets: receiptAssets,
    },
  };
}
