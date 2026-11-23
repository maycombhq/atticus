# v31 notes: three more map tools (ADR 0207 part 2)

Branch `b31/map-tools`. What the shared files should say, for whoever merges them.

## CHANGELOG.md (2.0.0-beta.31, Added)

- Three more read-only map tools for the personas (ADR 0207 part 2), served by `atticus mcp`:
  `owners` (who owns a record, a repo or a system, and where it is said: the System record, or
  the manifest or profile file; a manifest repo nobody read still has its manifest's owner, said
  "not read"), `consumers_of` (a topic's receivers, an API's or a repo's callers, each with its
  id and owner) and `similar_changes` (the archived changes nearest a change or a text). An id the
  map lacks is an answer, as for the other map tools.
- `atticus owners <id> [--json]`, and `atticus impact <id> --receivers`, which also takes a topic
  by its name and a repo by its id, as `ask` reads them.
- `atticus ask "who owns <id>"` now answers what `atticus owners` answers (the owner and where it
  is said), not the record alone. The query it shows is unchanged.
- The starter personas (not the naysayers) list the three tools. An org pack keeps its own files:
  [The map your personas ask](../../guide/the-map-your-personas-ask.md) gives the three lines to add.

## Decided in review (PR #6)

- `ask "who owns <repo>"` for a repo the manifests list asks of the repo (as `owners` does), not
  of its component and not as a word search, so a repo nobody read gets its manifest's owner.
- `owners` on a repo: its own manifest row's owner comes first, then the catalog's System record,
  then a profile's or another repo's row for its system. For any other record the order is
  `impact`'s: the System record, then the profile, then the manifest.
- A repo is read when the map cites it (a record's evidence or `repo`) or its facts file is
  there, so a repo with no component (schemas, a library) is read. A broken map is an error,
  never "not read".
- `similar_changes` takes `change` or `text`, never both: both is an error result.
- `consumers_of` (`impact --receivers --json`) answers `root`, `roots` (several), `receivers` and
  `further` only; `ask`'s receivers answer keeps the whole walk as before.
- Tests patch the Forge metarepo in a temp folder instead of extending `fixtures/forge-field`:
  that fixture's generator (`scripts/write-field-fixture.mjs`) belongs to another v31 branch.

## docs/build-status.md

- ADR 0207 part 2, three more map tools: built on `b31/map-tools` (tests:
  `packages/cli/test/mcp-owners-consumers.test.ts`, `packages/assistant-files/test/starter-persona-check.test.ts`).
  Parts 1 and 3 stay deferred (docs/plan/v31.md); part 4 is another builder's.

## docs/codebase-map.md

- `packages/cli/src/index-commands.ts`: `ownersCommand` (`atticus owners`); `impactCommand`'s
  `receivers` looks a topic's name or a repo's id up with `askLookup` when no record has the id.
- `packages/cli/src/map-lacks.ts`: `MapSides.ownerSaid` (an owner with the org-pack file that
  names it) and `MapSides.repo` (a manifest's repo, its system and owner).
- `packages/cli/src/mcp.ts`: the `owners`, `consumers_of` and `similar_changes` entries, and
  `oneOf` (a tool that needs one of several arguments).

## Surface census

`scripts/check-surfaces.mjs`: commands 284 to 285 (`atticus owners`). If another branch also adds
a command, the merged number is the sum.
