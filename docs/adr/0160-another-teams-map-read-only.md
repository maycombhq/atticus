# 0160. Another team's map, read-only

- Status: accepted (pending review by the product owner)
- Date: 2026-11-01
- Builds on: ADR 0124 (facts the assistant writes; addenda C-join, F3, O1, J2, F-bind), ADR 0135 (why a link is there), ADR 0142 (another team's spec as their system, O2), ADR 0149 (the outside systems page, O4), ADR 0151 (evidence from outside the code: the strip-then-mark pattern, the deny-list at import)

## Context

F3 and O2 made a profile system no estate repo belongs to (another team's, `boundary: internal`) an outside system: a call to it is left to its name on the join's `outside` list, and its Interface goes from our component to the system, cited at our end only. When that team publishes an OpenAPI spec, ADR 0142 matches our calls to its operations.

Some of those teams run Atticus themselves. Their verified facts say, with a line of their code each, what their services serve. Plan item O3 asks that their map be usable from ours: their entries become what our calls to their system join, cited on their lines, and stay theirs.

The rules that bind this: reads files only, no network (CLAUDE.md rules 4 and 5); a fact keeps its provenance, and ingested content is data, never instructions (rule 6); nothing of theirs is verified, corrected or reported on as ours.

## Decision

### 1. Their map comes in as files, under `shared/<team>/`

`atticus join shared import <folder> --team <id> --system <id> [--name <name>] [--commit <sha>]` (also `atticus estate shared import`) reads a clone or an export of their metarepo: its facts folder (`factsDirOf`, else the folder itself) and every `org-pack/profiles/*/repos.manifest.yaml` it has. It writes, in our metarepo, under `shared/<team>/` (`sharedDirOf`; `.atticus/shared` when adopted):

- `map.yaml`, schema 1 (`SharedMapFile`, core `shared-maps.ts`): `team`, `name`, `system` (the system of our profiles their map stands for), `source` (the folder as given, relative to the root when inside it), `commit` (their metarepo's), `importedAt`, and per repo the `component`, the code `commit` their facts cite, the `hosts` and `basePath` their manifest gives, and how many `entries` were kept;
- `facts/<repo>.jsonl`: their entry facts.

What is kept and what is refused:

- Only `entry` facts of the file's own repo that their verify confirmed (`verified` not `none`). Calls, fields, stores, configs and unconfirmed entries are left out and counted; a line that doesn't read is counted.
- A quote is redacted by `redactSecrets`; one naming a secret-looking key it can't place, or on a secret file's path, is dropped. The metarepo's `.denylist` is applied to what would be kept, as the traffic import does: a hit refuses the import and nothing is written.
- `--system` must be one of `outsideProfileSystems`: a system an estate repo belongs to is ours, not theirs. A repo id of our estate in their facts is refused. A system has at most one team's map.
- The commit is `--commit`, else read from the clone's `.git` files (HEAD, loose refs, packed-refs, a worktree's `gitdir`). Git is never run. Neither, refused.

`refresh [<team>] [<folder>]` imports again from the recorded source, or a new folder; a newer import replaces the old folder whole, commit and all. `list` prints what is on file. Their facts are never put in `facts/`, never passed to the verifier, the estate join or any model.

### 2. The join: calls left to their system, matched to their entries

After the estate join, `joinSharedMaps` (core, pure) takes the join's `outside` list: the calls left to a system by a person's answer, the call's `to`, or a host the system's aliases name (O1, F-bind). For each whose target names a system with a shared map (id, name or alias):

- their repos whose manifest hosts take the call's host (`callHostOf`); none named, all of them;
- among their entries of the call's type, REST by method and `routeScore` (their path, and their base path in front of it), gRPC and SOAP by `nameScore`, at the threshold the vendor match uses (a tail match on a context path doesn't count);
- one best is a match; two or more equally good, a question (`asks`, said on the write); none, a gap.

Chosen over adding their repos to `joinFacts` as read-only `JoinRepo`s: there, their entries would answer any of our calls by path alone (the join fallback), raise asks and exposure findings about their facts, and count in our join's numbers. Taking only what our join already left to their system keeps their map from changing anything else our join decides.

### 3. In the catalog: marks on our Interface, nothing of theirs as a record

The Interface a matched call made (from our component, to their system, citing our call's line) gets the flag `joined-to-shared-map` and an evidence entry on their entry's line: `source: code`, their repo, path, line and code commit, `side: callee`, `extractor: atticus-shared@1`, `by: <team>`. A call with no entry in their map gets `not-in-shared-map`, a gap.

- The Interface's `to`, id and confidence don't change. `to` stays their system: naming their component would make a record of ours rest on their naming and rename our Interface whenever they rename a component; no Component or Endpoint of theirs is written. The confidence isn't raised: their line was checked by their verify, not ours.
- Like contract and traffic evidence (ADR 0151), every write takes every shared mark off first (`stripSharedMaps`) and puts them back from the maps on file, over the whole estate's join (`applySharedMaps`), so the catalog is the same whatever order repos are written in, and a map taken away leaves nothing behind: with no map on file the marks still come off every repo's links, not only the written repo's.
- `joined-to-shared-map` is in `JOIN_HOW_FLAGS` (a how, never a gap).

`atticus verify <repo> --write` prints a `Shared map:` line per team and writes `shared` (`joined`, `unmatched`, `asked`) into `<repo>.verify.yaml`.

### 4. Where it shows

- Why is this linked?: `LINK_HOWS` gains `shared`; `HierJoin.shared` names the team, their repo, the line and their commit, read from the evidence. The panel says "Joined to <team>'s map (their commit …)", lists their line as text (never opened as a citation of ours), and says a wrong entry is theirs to fix: correct the call only if it goes elsewhere. A correction is always of our call fact; theirs are never in our corrections.
- Map › Outside systems (`GET /api/outside`): a system with a map gets `shared` (team, name, commit, imported at, each entry with how many callers reach it, and the calls their map has no entry for); a caller gains `entry` and `seen: shared`. Another team's system with no map says how to import one.

## Contract notes

- **C1:** unchanged. The flags and the `code` evidence with `extractor` and `by` already exist.
- **C4:** local API 2.44.0, additive: `LINK_HOWS` `shared`, `HierJoin.shared`, `OutsideCallView.entry` and `seen: shared`, `OutsideSystemView.shared`.
- **C6, the facts file:** unchanged. The shared map file is a file of its own, schema 1, with its zod schema in `core/src/shared-maps.ts`, as the contracts companion and the traffic aggregate are (ADR 0151). Nothing on disk changes, so no `atticus upgrade` step.

## Consequences

- A call to another team's system that runs Atticus is cited at both ends, theirs at their commit, and the gaps between what we call and what they serve are listed.
- Their map is only as fresh as the last import: `refresh` and the commit on file say how old it is.

**Not done here:**

- Their fields aren't kept, so no field lineage or field gaps cross into their map; their topics and listeners aren't joined (a publish to their topic stays outside).
- The asks aren't raised as questions on file; they are listed on the write.
- `atticus estate fresh` doesn't say when a shared map's source has moved past its commit.
