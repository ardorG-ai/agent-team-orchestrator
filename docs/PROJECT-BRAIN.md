# Project Brain

## Scope of the current branch

Project Brain in `0.2.0-dev.1` is a governed project-reference store inside the controller's SQLite database.

What is implemented now:

- Versioned `project_assets` with kinds `memory`, `skill`, and `knowledge`
- Optional memory layering with `l1`, `l2`, and `l3`
- Versioned `role_loadouts` with ordered asset references
- Injection modes `direct`, `summary`, `reference`, and `tool`
- Explicit one-role-to-one-active-loadout bindings
- Bounded prompt rendering at task claim time
- Signed audit receipts for asset creation, loadout creation/binding, and loadout snapshots
- CLI support for `asset add|list|show` and `loadout create|bind|list|show`
- GUI read projections for project assets, role loadouts, bindings, and resolved role context

What is not implemented:

- No autonomous Planner that invents work without an explicit team task
- No arbitrary or recursive model-selected sub-Agent DAG; the executable team graph is controller-fixed
- No automatic extraction of memory from run output
- No automatic summarization or promotion of model output into Project Brain
- No automatic write-back loop from review/verification results into assets or loadouts
- No secret-management guarantees

## Data model

### Project assets

Each asset is create-only and versioned by `(asset_key, revision)`.

- `memory` is for durable project facts or doctrine
- `skill` is for reusable operator-curated guidance
- `knowledge` is for external or tool-backed references

Memory assets can be tagged:

- `l1` atomic facts
- `l2` reusable incidents or heuristics
- `l3` curated project doctrine

Each stored asset includes a title, content text, content hash, and optional `source` metadata.

### Role loadouts

Each loadout is create-only and versioned by `(loadout_key, revision)`.

Each entry references an existing asset and carries:

- `assetId`
- `injectionMode`
- `priority`

Each loadout also has a byte budget that caps how much reference material may be injected into a worker prompt.

### Role bindings

Each role can have one active loadout binding at a time. Binding is a controller mutation with optimistic concurrency through `expectedCurrentLoadoutId`.

## Prompt injection behavior

At task claim time the controller:

1. Reads `task.payload.role`
2. Resolves the currently bound loadout for that role
3. Renders bounded role-reference text
4. Appends that material after the required-behavior block
5. Records a `task.event.loadout-snapshot` receipt with hashes, bytes, and truncation metadata

Injection modes behave differently:

- `direct`: inject the asset text into the prompt
- `summary`: inject the asset text into the prompt
- `reference`: inject only locator metadata such as the asset `source`
- `tool`: inject only locator metadata such as the asset `source`

`reference` and `tool` deliberately avoid placing the full underlying source body into the prompt.

## Security contract

Project Brain is governed reference context, not a secret store.

- `direct` and `summary` asset text enters the worker prompt
- `direct` and `summary` are trusted, operator-curated prompt guidance; do not use them for arbitrary external Markdown, copied model output, or unreviewed documents
- A model may restate that text in streaming output or final output
- Do not store secrets, tokens, or credentials in Project Brain assets
- Use `reference` or `tool` when external material should remain locator-only and must not directly shape the prompt
- Workers do not directly create assets, create loadouts, or bind loadouts from model output
- Raw model output is not auto-promoted into durable Project Brain state

Audit events intentionally avoid storing Project Brain bodies. Current mutation events store non-body identifiers such as:

- `assetId`
- `assetKey`
- `loadoutId`
- `loadoutKey`
- `revision`
- `contentHash`
- `role`

They do not store:

- raw asset body text
- `source`
- loadout `entries` arrays in event payloads
- Agent final messages or terminal messages in runtime audit events

## CLI workflow

Example asset creation:

```bash
node bin/agent-team.mjs asset add \
  --key memory/project-safety \
  --kind memory \
  --layer l3 \
  --title "Project safety doctrine" \
  --content "Never land an unverified candidate into main."
```

Example loadout creation and binding:

```bash
node bin/agent-team.mjs loadout create \
  --key builder/default \
  --role builder \
  --asset <ASSET_ID>:direct:10 \
  --byte-budget 2048

node bin/agent-team.mjs loadout bind \
  --role builder \
  --loadout <LOADOUT_ID> \
  --expect-unbound true
```

Useful notes:

- `--content` and `--content-file` are mutually exclusive
- `--layer` only applies to `memory`
- `--asset` accepts `ASSET_ID`, `ASSET_ID:MODE`, or `ASSET_ID:MODE:PRIORITY`
- omitted mode defaults to `direct`
- omitted priority preserves listed order

## GUI scope

The loopback GUI currently exposes Project Brain through read-only projections:

- project asset lists
- role loadout lists
- role bindings
- currently resolved role loadout for a selected role

Browser inspection is useful for debugging the active context, but the GUI is not yet the authoring surface for Project Brain mutations.
