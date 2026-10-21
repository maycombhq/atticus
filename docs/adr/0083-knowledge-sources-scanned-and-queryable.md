# 0083. Knowledge sources tagged, snapshot, scanned and queryable (C1, C6)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-21
- Builds on: ADR 0074 (the AI reads; every fact cites what a check confirms), ADR 0042 (ingested-content defences), revamp plan 4.3 and section 5

## Context

Code says what the estate does; wikis say how the organisation works: which integration pattern applies when, what a service on the house framework must do, which requests a change triggers and how long each takes, what is mandated or banned. Atticus already read wikis (`atticus sources sync`, `packages/knowledge`): it compared pages with the catalog, flagged stale pages and risky text, and `atticus patterns scan` read pattern codes from tables. It could not tell a scan what a source is about, it read the live source every time, and nothing turned prose into items a planner or a person could query.

The plan (section 5) asks for `Pattern` extended for patterns and standards, a new `ProcessDefinition` kind for request and process types, `Decision` for mandates and bans, and knowledge sources with tags.

## Decision

### Tags on sources (C6, `sources.yaml`)

Each entry under `wikis` may carry `tags: { kinds: [...], frameworks: [...] }`; its owner stays the existing `owner` field. Tags are free-text slugs; suggested kinds are `enterprise-architecture`, `integration-patterns`, `platform-runbook`, `security-standard`, `change-process` and `framework` (`SOURCE_KIND_SUGGESTIONS`). `atticus sources tag <source> --kind k,k --framework f,f --owner o` writes them into `sources.yaml`, keeping the rest of the file and its comments; the person commits the change through a pull request. (Unlike `atticus sources add`, which only prints the entry, this writes the file: a tag is a small, reviewable edit to an entry that already exists.)

### Snapshots (metarepo files)

`atticus sources sync [--source s]` now also copies every page it may read (the classification limit applies as before) to `knowledge/snapshots/<source>/<date>/` (`.atticus/knowledge/` in an adopted repo), with `snapshot.yaml` listing each page's path, copy, sha-256, title, date and classification, the source's tags and owner, and the pages skipped. A snapshot of the same source on the same day is replaced; older dates stay. The knowledge scan reads only snapshots: no network, and the same snapshot always gives it the same pages.

### The knowledge scan (`atticus knowledge scan [--source s] [--mode m] [--resume run]`)

AI → check → AI, through the AI runtime (hand-off by default):

1. **Defences.** Every page goes through `screenText` (ADR 0042). A span or line with an instruction-like signal (the instruction rules, a wrapper break-out, encoded instructions) is cut out of what the AI is given: a hidden span (an HTML comment, a hidden element) whole, a visible one by its line. It is recorded as an injection with page, line, heading and text, for a person. The rest of the page still goes through `buildContextPack`'s own defences, and a page they still quarantine is left out and reported.
2. **The AI reads** every page of the newest snapshot of each source, with each source's tags turned into guidance ("tagged change-process: look first for processes and requests ..."), and writes YAML: items of six kinds (pattern, standard, process, request, decision, constraint) with applies-when, rules, lead time, handled by, catalogue item, inputs, steps, status and dates, each with its page, heading and exact quote; conflicts between pages, quoting both; pages a newer page replaces; text that tries to instruct.
3. **Checks** (deterministic): each quote is word for word on the cited page and under the cited heading (whitespace and curly quotes folded, hidden text never counts), giving its line; `also_on` quotes the same; no item comes from a superseded page; no item repeats five words in a row of quarantined text; a conflict names kept items and each of its quotes is on its page; a superseded claim's quote is on one of the two pages (or the old page's front matter says `superseded-by`). Two kept items of one kind with the same title or catalogue item, on different pages, that disagree on lead time or handler, are flagged as a conflict by the check itself.
4. **Hand back.** What fails goes back to the AI with the reasons (default 3 attempts, `--attempts`). What still fails is reported and not kept.

Results: one canonical record per item at `knowledge/items/<kind>/<id>.yaml`, and `knowledge/scan.yaml` with the snapshots read, conflicts, superseded pages, injections and failed items. Scanning one source replaces only its items and flags.

### Records (C1)

- **`Pattern`, extended.** New optional fields `patternKind` (`integration-pattern`, the default, or `standard`), `rules`, and the knowledge fields below. `definition` and `interaction` become optional: a standard has no interaction, and a pattern read from a wiki may state no one-line definition. Existing org-pack-derived patterns are unchanged.
- **`ProcessDefinition`, new.** A type of process or request a change can trigger: `title`, `processKind` (`process` or `request`), `appliesWhen` (required), `leadTime`, `handledBy`, `catalogueItem`, `inputs`, `steps`, `notes`, `framework`, `tags`, `quote` (required), `alsoOn`. `ProcessArtifact` stays the instance raised or suggested for one change.
- **`Decision`, extended.** New optional `decisionKind` (`decision`, the default, or `constraint`), `stance` (`mandated`, `banned`, `retiring`), `dates`, and the knowledge fields. `reason`, `decidedBy` and `date` become optional: a wiki page states a ban without them. A decision a person records still has them.
- **Knowledge fields** shared by the three: `appliesWhen`, `handledBy`, `framework`, `tags` (the source's kinds and frameworks and the page's front-matter tags), `quote` and `alsoOn`, each a `KnowledgeQuote` (`source`, `page`, `section`, `text`, `snapshot` date, `line`). Evidence is `document` evidence on the snapshot copy with the quote's line; confidence is `inferred` (documents are never `asserted`). A conflict sets the flag `conflict:<page>|<page>`.
- `KNOWLEDGE_KINDS`, `KNOWLEDGE_RECORD_KIND` and `knowledgeKindOf` map the six knowledge kinds to the three record kinds.

### Queries

- `atticus knowledge list [--tag t] [--kind k] [--json]` lists items by any of their tags and by knowledge kind, marking items another page disagrees with.
- `atticus knowledge ask "<question>" [--mode m] [--resume run]` ranks items by the question's words (rarer words weigh more), gives the AI the items (never the pages), with their conflicts, and asks for an answer that cites item ids. The check refuses an answer that cites nothing, cites or names an id that isn't an item, or is empty; it hands it back once. A question no item shares a word with is refused before any AI step.

### The knowledge bench

`scoreKnowledge` and `runKnowledgeBench` (`packages/evals/src/knowledge-bench.ts`) score a scan against `bench/knowledge/reference.yaml`: items match one to one by kind and by Dice similarity of title (at least 0.5) or applies-when (at least 0.6) word sets, or the same decision code; quotes are re-checked against the corpus and must be on a page the reference names; conflicts by both pages; the superseded page by old and new, with no item from the old page; the injection by page, and "followed" when an item repeats five words of it; questions by whether the answer cites every expected item (the answer's prose is not judged). `atticus bench knowledge [--mode m] [--resume run]` builds a metarepo in the bench cache, snapshots the corpus, scans it, asks the eight questions in one AI run, prints the score and writes it to `<cache>/knowledge-results/`. Tests run it with MockRuntime and hand-written answers.

## Consequences

- C1 gains one kind (31 kinds) and optional fields on two; four fields become optional. Every existing record file reads unchanged, so the catalog schema version stays 2 and there is no migration; this is the same reading of rule 1 as ADR 0079 (an additive change). A reader built before this ADR rejects a record that uses the new fields, which is why the product owner should confirm the choice; bumping to version 3 would rewrite every golden file in the repo for no change in meaning.
- C6 gains `wikis[].tags`. Packs without tags behave as before; an untagged source is read for every kind.
- Every knowledge item quotes its snapshot and the check proves the quote is there (plan principle 2); whether the item reads the quote correctly is for review.
- Not built yet: knowledge repos cloned to `knowledge-repos/` (only folder and API wikis are synced, and the CLI has no API wiki adapter wired), re-reading only changed pages (every scan reads the whole snapshot), the app's sources and knowledge screens, the MCP tools, and the planning checks of plan 4.3's last bullet.
