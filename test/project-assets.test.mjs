import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { renderRoleLoadout } from '../src/project-assets.mjs';
import { openProjectStore } from '../src/project-store.mjs';

function createClock(start = 1_000) {
  let current = start;
  return {
    now() {
      return current;
    },
  };
}

function createIdGenerator(prefix) {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

function createStoreHarness(name) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  const dbPath = join(root, 'project-store.sqlite');
  const secretKeyPath = join(root, 'secret.key');
  writeFileSync(secretKeyPath, `${name}-secret`);
  const clock = createClock();
  const generateId = createIdGenerator(name);

  return {
    open() {
      return openProjectStore({
        dbPath,
        secretKeyPath,
        now: () => clock.now(),
        generateId,
      });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('renderRoleLoadout is deterministic, respects the stored byte budget ceiling, and omits reference bodies', () => {
  const harness = createStoreHarness('project-assets-render');
  const store = harness.open();

  try {
    const memory = store.createProjectAsset({
      assetKey: 'memory/runtime',
      kind: 'memory',
      memoryLayer: 'l1',
      title: 'Runtime memory',
      contentText: 'Always confirm exact verification output before declaring success.',
      expectedRevision: 0,
    }).asset;
    const knowledge = store.createProjectAsset({
      assetKey: 'knowledge/policy',
      kind: 'knowledge',
      title: 'Policy reference',
      contentText: 'This body should never be injected for reference mode.',
      source: {
        doc: 'policy.md',
        section: 'rendering',
        secret: 'must-not-enter-the-prompt',
        nested: { body: 'also private' },
      },
      expectedRevision: 0,
    }).asset;
    const tool = store.createProjectAsset({
      assetKey: 'skill/wiki',
      kind: 'skill',
      title: 'Wiki tool',
      contentText: 'Tool bodies stay out of the prompt.',
      source: { tool: 'wiki', action: 'search' },
      expectedRevision: 0,
    }).asset;

    const loadout = store.createRoleLoadout({
      loadoutKey: 'executor/render',
      role: 'executor',
      byteBudget: 1_024,
      entries: [
        { assetId: knowledge.assetId, injectionMode: 'reference', priority: 2 },
        { assetId: memory.assetId, injectionMode: 'direct', priority: 9 },
        { assetId: tool.assetId, injectionMode: 'tool', priority: 1 },
      ],
      expectedRevision: 0,
    }).loadout;

    store.bindRoleLoadout({ role: 'executor', loadoutId: loadout.loadoutId });
    const resolved = store.resolveRoleLoadout('executor');

    const full = renderRoleLoadout(resolved);
    const capped = renderRoleLoadout(resolved, { maxBytes: 405 });
    const repeated = renderRoleLoadout(resolved, { maxBytes: 405 });

    assert.equal(full.receipt.bytes <= 1_024, true);
    assert.equal(full.receipt.truncated, false);
    assert.equal(capped.receipt.bytes <= 405, true);
    assert.deepEqual(capped, repeated);
    assert.equal(capped.receipt.truncated, true);
    assert.equal(capped.text.includes('Always confirm exact verification output'), true);
    assert.equal(capped.text.includes('This body should never be injected for reference mode.'), false);
    assert.equal(capped.text.includes('Tool bodies stay out of the prompt.'), false);
    assert.equal(full.text.includes('Source locator:'), true);
    assert.equal(full.text.includes('"doc":"policy.md"'), true);
    assert.equal(full.text.includes('"tool":"wiki"'), true);
    assert.equal(full.text.includes('must-not-enter-the-prompt'), false);
    assert.equal(full.text.includes('also private'), false);
    assert.equal(capped.text.includes('"tool":"wiki"'), false);
    assert.equal(capped.receipt.assets[0].assetId, memory.assetId);
    assert.equal(capped.receipt.assets[0].includedBytes > 0, true);
    assert.equal(capped.receipt.assets[1].includedBytes > 0, true);
    assert.equal(capped.receipt.assets.some((asset) => asset.truncated), true);
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('renderRoleLoadout preserves resolved asset priority order under truncation', () => {
  const harness = createStoreHarness('project-assets-priority');
  const store = harness.open();

  try {
    const reference = store.createProjectAsset({
      assetKey: 'knowledge/high-priority',
      kind: 'knowledge',
      title: 'High priority reference',
      contentText: 'This body must stay out of the prompt in reference mode.',
      source: { tool: 'wiki', doc: 'priority.md', section: 'top' },
      expectedRevision: 0,
    }).asset;
    const memory = store.createProjectAsset({
      assetKey: 'memory/low-priority',
      kind: 'memory',
      memoryLayer: 'l3',
      title: 'Low priority memory',
      contentText: 'This lower-priority memory must not preempt the reference.',
      expectedRevision: 0,
    }).asset;

    const loadout = store.createRoleLoadout({
      loadoutKey: 'executor/priority-order',
      role: 'executor',
      byteBudget: 2_048,
      entries: [
        { assetId: reference.assetId, injectionMode: 'reference', priority: 9 },
        { assetId: memory.assetId, injectionMode: 'direct', priority: 1 },
      ],
      expectedRevision: 0,
    }).loadout;

    store.bindRoleLoadout({ role: 'executor', loadoutId: loadout.loadoutId });
    const resolved = store.resolveRoleLoadout('executor');
    const referenceOnly = renderRoleLoadout({
      ...resolved,
      assets: [resolved.assets[0]],
    });
    const capped = renderRoleLoadout(resolved, { maxBytes: referenceOnly.receipt.bytes });

    assert.equal(resolved.assets[0].assetId, reference.assetId);
    assert.equal(resolved.assets[1].assetId, memory.assetId);
    assert.equal(capped.receipt.bytes, referenceOnly.receipt.bytes);
    assert.equal(capped.text.includes('High priority reference'), true);
    assert.equal(capped.text.includes('Source locator:'), true);
    assert.equal(capped.text.includes('"doc":"priority.md"'), true);
    assert.equal(capped.text.includes('"section":"top"'), true);
    assert.equal(capped.text.includes('"tool":"wiki"'), true);
    assert.equal(capped.text.includes('This body must stay out of the prompt in reference mode.'), false);
    assert.equal(capped.text.includes('Low priority memory'), false);
    assert.equal(capped.text.includes('This lower-priority memory must not preempt the reference.'), false);
    assert.equal(capped.receipt.assets[0].includedBytes > 0, true);
    assert.equal(capped.receipt.assets[0].truncated, false);
    assert.equal(capped.receipt.assets[1].includedBytes, 0);
    assert.equal(capped.receipt.assets[1].truncated, true);
  } finally {
    store.close();
    harness.cleanup();
  }
});

test('renderRoleLoadout caps aggregate source locator metadata', () => {
  const harness = createStoreHarness('project-assets-locator-cap');
  const store = harness.open();

  try {
    const source = Object.fromEntries([
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
    ].map((key) => [key, `${key}-${'x'.repeat(300)}`]));
    source.secret = 'must-not-enter-the-prompt';

    const asset = store.createProjectAsset({
      assetKey: 'knowledge/large-locator',
      kind: 'knowledge',
      title: 'Large locator',
      contentText: 'The referenced body must stay outside the prompt.',
      source,
      expectedRevision: 0,
    }).asset;
    const loadout = store.createRoleLoadout({
      loadoutKey: 'researcher/locator-cap',
      role: 'researcher',
      byteBudget: 4_096,
      entries: [{ assetId: asset.assetId, injectionMode: 'reference', priority: 1 }],
      expectedRevision: 0,
    }).loadout;
    store.bindRoleLoadout({ role: 'researcher', loadoutId: loadout.loadoutId });

    const rendered = renderRoleLoadout(store.resolveRoleLoadout('researcher'));
    const locatorLine = rendered.text
      .split('\n')
      .find((line) => line.startsWith('Source locator: '));
    assert.ok(locatorLine);
    const locatorJson = locatorLine.slice('Source locator: '.length);
    const locator = JSON.parse(locatorJson);

    assert.equal(Buffer.byteLength(locatorJson, 'utf8') <= 1_024, true);
    assert.equal(
      Object.values(locator).every((value) => Buffer.byteLength(String(value), 'utf8') <= 256),
      true,
    );
    assert.equal(Object.hasOwn(locator, 'secret'), false);
    assert.equal(rendered.text.includes('must-not-enter-the-prompt'), false);
    assert.equal(rendered.text.includes('The referenced body must stay outside the prompt.'), false);
  } finally {
    store.close();
    harness.cleanup();
  }
});
