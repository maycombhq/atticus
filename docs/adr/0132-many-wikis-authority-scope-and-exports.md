# 0132. Many wikis: authority, scope, exports and scale (C6 sources.yaml version 3, C4 2.30.0)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-26
- Builds on: ADR 0012 (C6 org-pack schemas), 0051 (`atticus upgrade`), 0083 (knowledge sources tagged, snapshot and scanned), 0101 (rescans, reviews), 0124 addenda B-change (the footprint from target flows), A-framework (what a repo is built on) and B-task-knowledge (knowledge per task, pages that disagree), 0127 (include and exclude)

## Context

The product owner's organisation has 10 to 15 wikis, not one: enterprise architecture, security, a cloud platform's (GCP), framework wikis and many team wikis. `sources.yaml` version 2 took many sources, but:

- **No source counted for more than another.** Each task's ranking (`rankPages`, the near-duplicate lead) treated a page as "owned" when it had any owner or space, so the enterprise architecture standard and a team's notes ranked the same. With many wikis, a team page that contradicts a standard is the common case.
- **No source was scoped.** A GCP platform page reached a task that never touches GCP.
- **Nothing was measured at that scale**: a dozen sources of thousands of pages through the sync, the scan, the index and each task's matching.

A review of the first plan added: authority must not be a global sort key (a loosely related standard must never outrank the precise runbook for a task); authority comes from more than the source (an EA space holds drafts beside standards, a team wiki can host an adopted runbook, a page may be deprecated); banks run on approved exceptions; scope must match the change's target state (the org's rule "new components are built on GCP" is about components that exist only in the architecture stage's target flows); standards should become checks a person accepts; restricted pages must not reach a committed snapshot; snapshots must not copy every page on every sync; a scan's cost must be known before it runs; and where there is no wiki API, an export dropped into a folder must work. Expected answers, adversarial cases included, were written before the code (`fixtures/many-wikis/expected.yaml`).

## Decision

### 1. Authority: five, in three layers

`authority` on a source is one of `standard`, `platform`, `framework`, `team`, `reference`, most first. Five, because those are the kinds of voice the organisation's pages speak in, and each is ranked differently by the people who read them: the organisation's own rules (enterprise architecture, security); a shared platform team's guidance, which binds everyone on that platform; a framework's own documentation, which binds its users; a team's pages; and reference material (glossaries, notes, drafts), which informs and never decides. Fewer would put a platform's guidance and a team's notes together; more (an "approved team page", a "regulatory" level) are better said per page, by `byPage`, than as more levels. A source without one ranks as a team's: a version 2 file read at version 3 ranks every page as before.

The three layers, in order (`pageStanding` in core): the source's default; `byPage`, the first entry whose page patterns match (as `include`/`exclude` match), setting an `authority` or a `status`; then what the page says of itself, a status or label (deprecated, obsolete, superseded, archived), an archived space, or a banner near its top ("Deprecated: superseded by …"). A page no longer current ranks below every current page, whatever its source. `reviewMonths` on a source marks a standard not updated within it "may be out of date"; it is shown, it doesn't demote.

### 2. Authority decides only on one topic

Each task's list stays ordered by relevance (the words and places it matched). Authority decides only between pages on the same topic: an entry's own pages, near-duplicate entries, and pages that disagree. Within a topic the order is: current; verified by a person; more authoritative; newer; owned; the closer match (`comparePages`). An entry led by a page no longer current has its score halved. Near-duplicates gain two cases: a section headed with every word of an item's title, or whose words are mostly the item's (a draft of a standard, a copy that has drifted), groups under the item; two sections of one page are one entry.

### 3. Who is suggested when pages disagree

Read when the conflict is shown (`standingSuggestion`), so a change to `sources.yaml` applies at once and an older scan's report reads the same way: (1) **status**, the one current page; (2) **exception**, a less authoritative page that says "exception" or "waiver", gives an approval (an ADR, waiver or exception id, or "approved by") and names the other page by title or path, suggested within its source's scope, and the other page outside it (`otherwise`, which each task's view uses when the task is outside the scope); (3) **authority**, the one most authoritative page, saying when a standard may be out of date. Otherwise the scan's own signal (ADR 0124 addendum B-task-knowledge) stands. Every one is a suggestion: a person still answers the question, and a fact verified from code still settles it first.

### 4. Scope matches the catalog and the target state

`appliesTo` names `systems`, `components`, `platforms`, `repoTypes`, `frameworks` and `newComponents: true`; any one matching is enough. These are what the estate can actually match: a component's system, `runtime` and deployments' `platform` (catalog), its repo's `type` and `system` (the repos manifests), its repo's framework facts (ADR 0124 addendum A-framework), and what the task calls (its targets, for systems and components only: a page of the platform a callee runs on is not about the caller's code). A cloud stands for its platforms (`gcp` takes in `cloud-run`, `gke` …). A scoped source's pages attach only to the tasks whose places fall in it; each attached page says the scope it matched.

The target state: a new flow of a component the catalog doesn't have yet says where that component runs, `runsOn: { component, system, platform, cloud, framework }` on the target flow (planner stage file, optional, additive at version 2; the architecture prompt asks for it). Every task of that flow works in the new component with that placement; the first task creates it (`newComponents`), and "build and deploy a new service" is among what it changes, so the platform's new-service how-to matches it.

The change's own list (`knowledge.yaml`, the stages') isn't scoped: it is the change as a whole. Each task's is.

### 5. Standards become checks a person accepts

The scan already reads a standard's `rules`, and the stages already put them in their prompts as context. `atticus standards propose` proposes each rule of a standard a person confirmed (verified or corrected), on a page whose standing is `standard`, as a C3 AI checklist rule citing the page and item (`proposals/checklists/standards.yaml`); a rule that says should or recommended is a risk, any other a blocking, waivable rule. Nothing is enforced: `atticus standards accept` puts what a person picks into `org-pack/checklists/standards.yaml`, and the pull request is the approval. C3 is used as it is.

### 6. Restricted pages

A page under view restrictions (front matter `restricted: true` or `restrictions`, which the export adapters and an API adapter that knows write) is skipped as above the limit, path and reason only, unless the source has `readRestricted: true`.

### 7. Exports as sources

`confluence-export` (a space exported as HTML: breadcrumbs give the page's place, so `byPage` patterns work; the metadata line, labels and a restriction marker where the export has one) and `sharepoint-export` (pages saved as HTML, `.aspx` or Markdown, with the pages library's metadata `.csv`: Title, Modified, Modified By, labels, status, `HasUniqueRoleAssignments`). Each page becomes Markdown with the metadata as front matter, so standing, scope, restrictions and the scan apply as to any page.

### 8. Storage and incremental work

A snapshot copies only the pages new or changed since the source's previous snapshot; an unchanged page is listed with `in: <date>` (snapshot manifest version 2, knowledge-local). Readers follow it: `readSnapshot`, the index, a quote's `snapshot` date. The same page mirrored in two wikis (the same words, front matter aside, at least a dozen) is read once, by the more authoritative source, then the first listed. The scan already re-read only changed pages (ADR 0101); a source's `maxPages` caps the pages one run reads of it. `atticus sources estimate` gives pages, tokens and model calls per source before a scan.

### 9. Version 3 and its migration

`SOURCES_SCHEMA_VERSION` is 3. Version 1 and 2 files still read; the version 3 fields and types in an older file are refused with "needs schemaVersion 3: run atticus upgrade". `atticus upgrade` runs `sources-v3` after `sources-v2` (a version 1 file goes to 2, then 3, in one run), changing only the number and keeping comments, order and line layout. `atticus init` and `atticus adopt` write version 3.

## Measured

On the invented Forge shop's 12 sources (2 standards, 2 platforms, 2 frameworks, 5 teams, 1 reference) with the generator's 4,800 filler pages (`packages/synth/src/wikis.ts`, deterministic), on the 2-CPU build machine (`packages/m5-exit/test/perf-wikis.test.ts`, run alone):

| Step                                                               | Time                                                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Sync, 4,832 pages read (17 skipped: 2 restricted, 15 mirrors)      | about 5 to 7 s                                                                                       |
| A later sync, 1% of pages changed                                  | about 4.7 s, 48 pages copied                                                                         |
| `atticus sources estimate`                                         | about 3 s                                                                                            |
| Knowledge scan, every page, a mock model writing one item per page | about 37 s, 6 model calls, 4,828 items                                                               |
| Rescan after 10 pages changed                                      | about 4 s, those 10 pages read                                                                       |
| Index build                                                        | about 10 to 12 s (was over a minute)                                                                 |
| 14 tasks' knowledge, one call                                      | about 5 s                                                                                            |
| 14 tasks' knowledge, one call each (as `atticus task context`)     | about 25 to 28 s                                                                                     |
| Peak memory                                                        | about 830 MB                                                                                         |
| Git history after five syncs (1% of pages changed each), packed    | 2.1 MB → 2.5 MB (+22%)                                                                               |
| Snapshot working tree after five syncs                             | 5,084 files, 10.5 MB (4,844 files, 4.8 MB after the first; a full copy a sync would be 24,000 files) |

What didn't hold up, and was fixed: the index looked up full-text rows by key, a scan of every row for every node, quadratic (68 s to build at 4,800 pages, 6 s after; `INDEX_VERSION` 5 rebuilds an index once); a rescan's plan looked a page's text up by a linear find, per page, per batch; each task's knowledge read whole snapshots (every page parsed) to show a few pages, now one file at a time; the same page in two wikis was read, scanned and indexed twice; a sync copied every page every time.

The matching (`packages/evals/src/many-wikis-bench.ts`, `docs/evidence/context-eval.md`), before (no authority, scope or status) and after:

| Run                 | Selection | Recall | Precision | Out of scope listed | Leads right | Suggested right |
| ------------------- | --------- | ------ | --------- | ------------------- | ----------- | --------------- |
| Planted pages (32)  | before    | 0.96   | 0.39      | 2                   | 2 / 7       | 0 / 4           |
| Planted pages (32)  | after     | 0.96   | 0.50      | 0                   | 5 / 5       | 3 / 4           |
| With filler (4,832) | before    | 0.96   | 0.27      | 2                   | 2 / 7       | 0 / 4           |
| With filler (4,832) | after     | 0.96   | 0.34      | 0                   | 5 / 5       | 3 / 4           |

Recall is unchanged: the one miss (task 1.4's TLS standard) is the search engine not offering it. Precision rises but stays low: the words rule is lexical, and drafts, meeting notes and glossary entries that share a task's words still attach (they rank as reference, which decides nothing on its own).

## Contracts

- **C6**: `sources.yaml` version 3, with the migration above.
- **C4 2.30.0, additive**: a knowledge source's `authority`, `appliesTo`, `scope` (in words), `byPage` (count), `readRestricted`, `maxPages`; the two export types in `WIKI_TYPES`; `authority` and `scope` on onboarding's wikis; a conflict's `suggested.signal` gains `status`, `exception` and `authority`; a change's knowledge item gains `source` and `authority`. The C4 wiki adapter is unchanged: an adapter that gives a page's `labels` or `restricted` has them read.
- C1, C2, C3 and C5 don't change. The planner's target flow gains the optional `runsOn`; the snapshot manifest (knowledge-local) goes to version 2 and still reads version 1; the index's tables (a local cache) go to version 5.

## Consequences

- A team page that disagrees with a standard is asked about with the standard suggested, or the team's approved exception within its scope; a deprecated page never leads; a GCP page reaches a task on GCP or one that creates a new component, never a task that doesn't.
- Not done: the snapshot manifests now dominate what a sync adds (each lists every page; about 1 MB a sync at this scale), a later change could list only what moved; the change's stage-level knowledge list isn't scoped; the matching is lexical (low precision, measured); an export's restrictions are read only where the export carries them (a Confluence HTML export usually doesn't: use the `.csv` beside it or `readRestricted`); `atticus task context` per task (about 1.8 s each at 4,800 pages) re-lists every source file to open the index; a snapshot folder an `in` points into must be kept.
