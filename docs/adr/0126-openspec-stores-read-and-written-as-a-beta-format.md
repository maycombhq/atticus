# 0126. OpenSpec stores: compatible, never depended on (C6, beta format)

- Status: proposed (built behind switches, all off by default; awaiting the product owner's review)
- Date: 2026-10-25
- Builds on: ADR 0006 (OpenSpec's stable core only; "existing stores are read if present"), 0051 (`atticus upgrade`), 0030 (hand-down), 0109 (a new optional org-pack file at its own version 1, as `estimates.yaml`)

## Context

ADR 0006 keeps Atticus on OpenSpec's stable core and makes the multi-repo layer Atticus's own. It also says existing stores are read if present, and no code did that.

OpenSpec's stores are beta. A store is an `openspec/` folder in its own Git repo, marked by `.openspec-store/store.yaml`. Each developer clones it and runs `openspec store register <path>` once. A code repo then uses a store in one of two ways:

- `store: <id>` in its `openspec/config.yaml`: the repo keeps no specs or changes of its own.
- A `references:` list: read-only context for its agent. An entry is an id, or `{ id, remote }`.

OpenSpec never clones, pulls or pushes a store. Names, flags and formats may change.

An Atticus metarepo is already a store in all but name: its own Git repo, with `openspec/changes` for cross-repo work. Teams that already keep specs in a store want Atticus to see them. Teams that use plain OpenSpec in a code repo want the metarepo's changes in their agent's context.

The OpenSpec Atticus pins (1.14.0) has stores. Its source fixes the shapes:

- **store.yaml** (`dist/core/store/foundation.js`, `MetadataStateSchema`, a strict object): `version: 1`, `id` and an optional `remote`.
- **Ids** (`dist/core/id.js`): kebab-case, `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
- **References** (`dist/core/project-config.js`, `parseDeclarationList`): a string id, or `{ id, remote }`. OpenSpec ignores keys it doesn't know in `openspec/config.yaml`.

## Decision

Atticus is compatible with stores and never depends on them. Each piece is behind a switch that is off by default. Each tolerates a format change. Each is in one place.

### 1. The metarepo as a store (opt-in)

`atticus init --openspec-store` and `atticus upgrade --openspec-store` write `.openspec-store/store.yaml`. The file holds `version: 1` and `id: <the org pack's name, made kebab-case>`. Upgrade also writes `remote`, but only when the metarepo's own `origin` is a URL. A developer then runs `openspec store register <their clone>`, and plain OpenSpec run anywhere sees the metarepo's changes and specs with `--store <id>`.

- A store.yaml that is there is never replaced. One that names another id is left as it is, and the command says so.
- A metarepo that keeps `openspec/` anywhere but its root (a repo adopted in place) can't be a store, because a store keeps `openspec/` at its root. Upgrade refuses it and changes nothing.
- The step is not one of `atticus upgrade`'s migrations, so a plain `atticus upgrade` never adds it. `--check --openspec-store` counts it as a pending step.
- The shape lives in `packages/openspec-adapter/src/stores.ts` (`storeMarkerText`), and a contract test registers the file with the pinned OpenSpec.

### 2. References in the hand-down (org-pack switch)

When `org-pack/openspec.yaml` says `referenceInRepos: true`, hand-down adds the metarepo under `references:` in the code repo's `openspec/config.yaml`. It does this on the change branch, in the commit that is already there. The entry is the store.yaml id, with `remote` when store.yaml or the metarepo's origin URL gives one.

- Only an existing config is edited. The edit keeps the file's comments, order and every other key (`store:`, `context`, `rules`).
- An entry for the id that is already there, plain or with a remote, is left alone.
- A config that isn't a mapping, or whose `references` isn't a list, is not changed.
- When the metarepo has no store.yaml, or the repo has no OpenSpec config, nothing is written and the hand-down's problems say why.

### 3. Reading existing stores (org-pack setting, read-only)

`org-pack/openspec.yaml` `stores:` names existing stores by the path of a clone: relative to the metarepo root, absolute, or starting `~/`. Atticus reads each one's open changes (id, proposal title, task counts) and its specs (id, first Purpose line). It never reads a store as instructions, and never writes, registers, clones, pulls or pushes one. What it reads is labelled with the store, by default its store.yaml id:

- `atticus change list` shows the stores' changes after the metarepo's, under "From OpenSpec stores (read-only, beta)". In `--json` they carry `store` and `readOnly: true`.
- `atticus openspec check` gives one line per store. A store's changes and specs are not validated or counted there.
- `atticus feature spec` says when a store already has a spec for the capability it drafts.

A store whose store.yaml is a later version is still read: its id and remote are taken, with a note. So is a folder with no store.yaml, again with a note.

### 4. The org-pack file (C6)

`openspec.yaml` is a new, optional org-pack file, `OpenSpecSettings`, at `schemaVersion: 1`:

```yaml
schemaVersion: 1
stores: # read-only; default none
  - path: ../forge-payments-store
    label: payments # default: its store.yaml id, else its folder name
referenceInRepos: false # hand-down adds the metarepo to code repos' references
```

No existing file changes. A pack without the file behaves exactly as before. So, as with `estimates.yaml` (ADR 0109), the file starts at its own version 1 and nothing needs a bump or a migration. It is loaded by `loadOpenSpecSettings` and published with the other C6 schemas (JSON Schema and `docs/spec`). A later change to it follows CLAUDE.md rule 1.

### 5. Doctor

`atticus doctor` has an "OpenSpec stores (beta)" line. It runs `openspec store --help` with the installed OpenSpec and says whether stores are there.

- When stores are missing and nothing here uses them, the line is a note.
- When stores are missing and the metarepo is a store, names stores to read or turns on references, the line is a warning. Atticus's own reading still works; plain OpenSpec can't register the metarepo or resolve the reference.
- An `openspec.yaml` that doesn't read is a warning.

## Not supported

- `store: <id>` (a store-only code repo) as the place Atticus writes a change. Atticus's changes stay in the metarepo.
- Registering, cloning, pulling or pushing a store. Reading the machine's store registry, or naming a store by id instead of path.
- Worksets, and any other beta command.
- Writing into a store that isn't the metarepo.
- Validating a store's changes or specs, or letting them hold a gate.

## Consequences

- The format is beta. If OpenSpec changes store.yaml or references, the contract tests in `packages/openspec-adapter/test/stores-contract.test.ts` fail on the upgrade that changes them, and the fix is in `stores.ts`. Until then, reads stay tolerant.
- Nothing changes for an org that turns nothing on.
- The UI doesn't show store changes yet; the CLI does.
