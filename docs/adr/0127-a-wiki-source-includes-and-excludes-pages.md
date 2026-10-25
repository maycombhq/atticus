# 0127. A wiki source includes and excludes pages (C6 sources.yaml version 2)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-25
- Builds on: ADR 0012 (C6 org-pack schemas), 0051 (`atticus upgrade`), 0083 (knowledge sources tagged, snapshot and scanned; addendum K-docs), 0101 (git wikis)

## Context

A knowledge scan of a project's docs folder (103 Markdown pages) needed only part of the folder in one source and a sub-folder in another, with its own tags. A `sources.yaml` wiki had no way to say which pages it reads, so the person added a second source for the sub-folder, which overlapped the first. Every page in the sub-folder was then snapshotted, scanned and indexed twice, once under each source.

## Decision

### 1. `include` and `exclude` on a wiki

Each entry under `wikis` may carry `include: [<pattern>, ...]` and `exclude: [<pattern>, ...]`. They are page patterns relative to the source, written with `/`:

- `**` spans folders, `*` stays within one folder, and `?` matches one character.
- A pattern ending in `/`, or with no wildcard, also takes everything under the folder it names. For example, `runbooks/` and `runbooks` both mean `runbooks/**`.
- A leading `/` and `..` are refused.

A source reads a page when the page matches one of its `include` patterns (or the source has none) and none of its `exclude` patterns. `pageGlobMatches` and `sourceReadsPage` in `packages/core` implement this.

The sync applies the patterns to every source type, not only folders. A page a pattern leaves out is not "skipped": a skip is something to review, and this is the source's own scope.

### 2. A page two sources cover is read once

When two sources still cover the same file (the same evidence path), the source nearest to it reads it: the one whose path for the page has the fewest folders, which is usually the source made for that folder. On a tie, the first source listed reads it. The other source's sync and snapshot list the page as skipped, with the reason "also in `<source>` (as `<its path there>`), which reads it". The metarepo's own `inputs/` source keeps its existing check: a copy of a wiki page is matched by its content (ADR 0122).

### 3. Version 2, and its migration

`sources.yaml` gets its own schema version (`SOURCES_SCHEMA_VERSION`), as `change-types.yaml` and `gates.yaml` did (ADR 0113, 0087):

- Version 1 files still read.
- `include` or `exclude` in a version 1 file is refused with "include needs schemaVersion 2: run atticus upgrade". An earlier Atticus would otherwise refuse the file with an unclear "unrecognized key" error.
- `atticus upgrade` runs a new step, `sources-v2`, which changes nothing but the number. A wiki with neither field reads every page, as every wiki did in version 1. The step keeps the file's comments and order.
- `atticus init` and `atticus adopt` write version 2.

## Consequences

- C6 gains two optional fields and a version. Packs at version 1 behave as before until they are upgraded.
- The sync, the snapshots, the scan and the index all see one copy of a page.
- Not done: `atticus sources add` has no `--include` or `--exclude` flags. A person writes the patterns into `sources.yaml`.
