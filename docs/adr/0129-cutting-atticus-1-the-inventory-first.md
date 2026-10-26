# 0129. Cutting Atticus 1: the inventory first, then only what has a replacement

- Status: accepted (the product owner approved the cut on 2026-10-26: "Yes but nothing should break and we shouldn't lose UI functionality and depth")
- Date: 2026-10-26
- Builds on: ADR 0074 (the AI reads, code verifies), 0124 (facts the assistant writes, and its D-cli addendum: the twelve commands with `legacy`), 0124 addendum B-change (a change read from what its stages write)
- Amends: nothing. This ADR removes no contract and no decision; it records what Atticus 1 still is, what in Atticus 2 does each job, and what may therefore go.

## Context

An independent architecture review (2026-10-25, finding 7) found that Atticus carries two generations at once:

- **Atticus 1** — the deterministic path: built-in readers and dialect rules read a repo, extractors write C1 records, a scan rebuilds the catalog, and a change is carried in hand-written artifacts (`proposal.md`, `interfaces.md`, `data.md`, `change.yaml`'s `touches`).
- **Atticus 2** (ADR 0124) — the assistant reads a repo and writes cited facts, `atticus verify` checks each claim on its line and projects the facts into the same C1, and a change is read from what its stages write (addendum B-change).

The review put the cost at about 47 packages and far too many commands. The product owner approved cutting Atticus 1 with one condition, in his words: **"nothing should break and we shouldn't lose UI functionality and depth."**

That condition decides the shape of this work. The aim is less code and fewer commands **for the same capability**, not a smaller product. A cut that removes a page, a view or a command people have in a runbook is not a cut; it is a regression.

So the first thing built is not a deletion. It is this inventory.

## Decision

### 1. Nothing is cut that has no Atticus 2 replacement

Every Atticus 1 surface is listed below with one of three verdicts:

- **Cut** — Atticus 2 does the job today, proven on the bench or by a test, and the code goes.
- **Cut, deferred** — Atticus 2 does the job, but the surface is wired into the editors or the AI step registry, so removing it is its own ticket with its own tests. Named here so it is not forgotten.
- **Kept** — nothing in Atticus 2 does this job. It stays, whatever generation it came from. "Legacy" in the codebase map has never meant "going"; it means "not in the default twelve".

A surface with no replacement is not cut in this work. The inventory is the contract: a later session that wants to delete something looks here first, and if the row says Kept, it needs a new ADR, not a tidy-up.

### 2. The inventory

#### 2.1 Packages (57 today; 17 of Atticus 1 origin)

| Package         | Atticus 1 role                                                                                                | What does the job in Atticus 2                                                                                        | Verdict                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extractors`    | The built-in readers and the dialect rule engine: the whole reading path                                      | The assistant's facts (`atticus map`), checked by `verify`                                                            | **Kept.** ADR 0124 §3 keeps the readers as the optional cross-check — agreement confirms a fact, disagreement is a finding — and `outline` and `namesInCode` use their parsers. Cutting them removes the cross-check and two tools the assistant reads with. |
| `assistant-kit` | The dialect build kit, and the reader-path AI steps (`scan survey`, `scan verify`, `spec draft`)              | `atticus map` + `atticus verify` for the three steps; nothing for the dialect and framework kits                      | **Split.** The three reader-path steps are _Cut, deferred_ (§2.2). The dialect kit stays while the readers stay; the framework kit is live Atticus 2 work (ADR 0124 addendum A-framework).                                                                   |
| `adapters`      | Work tracker, service desk, Git host, wiki, notifications, design tool, each with a mock and a manual version | Nothing. The hand-off PR uses the Git host adapter; the manual adapter is the default everywhere                      | **Kept.**                                                                                                                                                                                                                                                    |
| `ci`            | The pipeline drift check, CI snippets, the archive gate                                                       | Nothing                                                                                                               | **Kept.**                                                                                                                                                                                                                                                    |
| `diagrams`      | Mermaid and draw.io views                                                                                     | Used _by_ Atticus 2: `flowSequenceView` draws every map flow (ADR 0124 addendum A3b)                                  | **Kept** — and no longer legacy in substance.                                                                                                                                                                                                                |
| `features`      | Features found in code, named, tagged, linked to work items                                                   | A fact's `entry` projects to `Endpoint`, and a screen or schedule to a `Capability` trigger — the detection half only | **Kept.** Naming, tagging, merging, splitting and work-item links have no Atticus 2 equivalent, and the Features page reads them.                                                                                                                            |
| `glossary`      | Business terms from wikis, code and people                                                                    | `knowledge` reads terms from wikis (ADR 0102) — the wiki half only                                                    | **Kept.** The code and people sources, `glossary define/link/alias`, have no replacement.                                                                                                                                                                    |
| `intake`        | `inputs/` intake, triage, payload samples                                                                     | `knowledge` reads documents from `inputs/` (ADR 0122) — the documents half only                                       | **Kept.** Triage, duplicates, versions and payload samples have no replacement; the Intake and Triage pages read them.                                                                                                                                       |
| `ingestors`     | Diagram and document readers (Lucid, Visio, Mermaid, Office, PDF, Markdown, Figma)                            | Nothing; the scan, the index and the planner all use them                                                             | **Kept.**                                                                                                                                                                                                                                                    |
| `reconcile`     | Diagram against code, aliases                                                                                 | Nothing; knowledge uses it                                                                                            | **Kept.**                                                                                                                                                                                                                                                    |
| `release`       | Deployment plan, forecast, evidence pack, notes, outcomes, security review                                    | Nothing                                                                                                               | **Kept.**                                                                                                                                                                                                                                                    |
| `initiatives`   | Initiatives, guided journeys, commitments, system cards                                                       | Nothing                                                                                                               | **Kept.**                                                                                                                                                                                                                                                    |
| `learn`         | Role lessons, the practice sandbox, `atticus explain`                                                         | Nothing, and `explain` is in daily use                                                                                | **Kept.**                                                                                                                                                                                                                                                    |
| `stubs`         | Stub servers from specs or the catalog                                                                        | Nothing                                                                                                               | **Kept.**                                                                                                                                                                                                                                                    |
| `site`          | System guides and the read-only catalog site                                                                  | Nothing                                                                                                               | **Kept.**                                                                                                                                                                                                                                                    |
| `executors`     | Step executors over HTTP, command and MCP                                                                     | Nothing                                                                                                               | **Kept.**                                                                                                                                                                                                                                                    |
| `synth`         | A synthetic estate for scale tests                                                                            | Nothing; the scanner imports it                                                                                       | **Kept.**                                                                                                                                                                                                                                                    |

**Count: of seventeen Atticus 1 packages, none can be removed today without losing capability.** That is the honest answer to finding 7's "about 47 packages": the package count is not carrying a second generation that nobody uses. It is carrying one generation's reading path (now a cross-check) and a long tail of capability — release, initiatives, intake, glossary, features, stubs, site, executors — that Atticus 2 never set out to replace and has not replaced.

Where packages _can_ go at no cost is the test-only tail, which belongs to no generation:

| Package                         | What it is                                                                                   | Verdict                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `m3-exit`, `m4-exit`, `m5-exit` | Three private, source-less packages, each holding one milestone's exit suite                 | **Merge deferred** to `packages/milestones` (−2). They export nothing, so no import moves — but their suites run at 30 s, 120 s and 600 s timeouts, and M5's are performance budgets that already failed under full load (`docs/build-status.md` A2). Putting them in one vitest run raises the load those budgets are measured under, so the merge has to be measured, not assumed. |
| `fixtures`, `harbor-tests`      | Two private, source-less packages that keep the Forge and Harbor fixtures consistent with C1 | **Merge deferred** to `packages/fixture-tests` (−1). Same shape, and no budgets — but one timeout would have to cover both (30 s and 120 s), which loosens the Forge fixtures' bound. Worth doing with per-file timeouts; not worth doing by weakening a check.                                                                                                                      |

**Packages: 57 → 57 in this work**, with the two merges above scoped and their reasons for waiting recorded (ticket Cut-3). A package count is not worth a weakened check.

#### 2.2 Commands (223 distinct, 93 groups)

| Command                                                                                                      | Atticus 1 role                                                                                     | What does the job in Atticus 2                                                                                                               | Verdict                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scan survey <repo>`                                                                                         | The assistant drafts a repo's scan settings: folders to leave out, path prefixes, client base URLs | `atticus map <repo>` — the assistant reads the repo itself; ADR 0124 §3 says scan settings stop being the path to accuracy                   | **Cut, deferred**                                                                                                                                                                                                                                                               |
| `scan verify <repo>`                                                                                         | The assistant compares the code with the last scan and says what it missed                         | `atticus verify <repo>` — the verifier checks each fact's claim on its line                                                                  | **Cut, deferred**                                                                                                                                                                                                                                                               |
| `scan review <repo>`                                                                                         | The assistant gives a verdict on each gap the scan left                                            | `verify`'s coverage report and `questions/`                                                                                                  | **Cut, deferred**                                                                                                                                                                                                                                                               |
| `spec draft <repo>`                                                                                          | The assistant writes the repo's flows, one per trigger                                             | `atticus verify <repo> --write` writes `specs/<repo>/<id>.yaml` from the facts (ADR 0124 addendum A3b)                                       | **Cut, deferred**                                                                                                                                                                                                                                                               |
| `change draft <change>`                                                                                      | Drafts `proposal.md`, `interfaces.md` and `data.md` from the brief                                 | `change feature` → `change architecture` → `stories`, whose files the footprint, risk, conflicts and test kinds now read (addendum B-change) | **Kept, for now.** B-change still reads Atticus 1's files "when a legacy change has them". That is the upgrade path for a metarepo with a change in flight; removing it breaks an old metarepo, which §4 forbids. It goes when `atticus upgrade` migrates a change's artifacts. |
| `scan`, `catalog *`, `dialect *`, `repo-type *`, `plugin *`, `onboard *`                                     | The deterministic reading path and its tooling                                                     | The readers, kept as the cross-check                                                                                                         | **Kept**, with the readers.                                                                                                                                                                                                                                                     |
| Everything else (release, initiative, glossary, intake, triage, stub, site, executor, learn, feature, ci, …) | —                                                                                                  | Nothing                                                                                                                                      | **Kept.**                                                                                                                                                                                                                                                                       |

Why the four reader-path steps are deferred rather than cut here: each is a named step in the AI step registry (`packages/ai/src/step-class.ts`), in VS Code's guided walkthrough and step models (`packages/vscode/src/guided.ts`, `step-models.ts`), in IntelliJ's `StepModels.kt`, in `assistant-files`' generated slash commands, in the planner's stage schema and in the app's run-step words. Removing them touches about thirty-five files across eight packages and two languages. Taking that in the same change as the inventory would risk exactly what the product owner's condition forbids. It is one ticket of its own, listed in `docs/build-status.md`, with the surfaces above named so nothing is missed.

**Commands: 223 → 223 in this work.** The surface is unchanged because no replacement was proven here that the editors do not also depend on. §4 says how a retirement, when it comes, keeps a runbook working.

#### 2.3 Screens (52)

Every one of the app's 52 pages has a component (`SCREEN_COMPONENTS`), is reached from the six entries or from More pages, is found by Ctrl+K, and keeps its old address (`OLD_ADDRESSES`). `packages/ui/test/screens.test.ts` asserts all of that, and `packages/journeys/tests/14-every-screen.spec.ts`, `23-atticus-2-metarepo.spec.ts` and `25-more-pages-atticus-2.spec.ts` open every page on a real Atticus 2 metarepo (`fixtures/forge-studio`) and fail on an API error, a page error or an accessibility violation.

Five pages whose only source was an Atticus 1 artifact — the feature brief, prototypes and UX, the architecture review, API mappings and reconcile — were given their Atticus 2 behaviour on 2026-10-25 (ADR 0124 addendum D-app follow-up): each asks only for the artifacts its change actually lists (`listsArtifact`), and where a change has none it says in words what Atticus 2 writes instead rather than failing with an HTTP error. `packages/ui/test/atticus-1-pages.test.ts` holds that.

**Screens: 52 → 52.** No page is hidden, removed or made worse by this ADR.

#### 2.4 Readers, dialects, extractors

No reader is retired. ADR 0124 §3 is explicit that the readers are never the path to accuracy but are kept as the cross-check, and that `outline` and `namesInCode` use their parsers. Retiring one would need a bench run showing what replaces it, which this work does not have.

#### 2.5 Contract surfaces

C1 to C6 are untouched, and so is the facts file (`packages/core/src/schema/facts.ts`, additive to C1 since ADR 0124). This ADR changes no schema and needs no version bump or migration.

### 3. What the cut actually buys, honestly

No packages, no commands, no screens, no readers and no contracts. That is a small result against finding 7's framing, and it is the true one: the inventory shows that most of what the review counted as a second generation is either Atticus 2's own cross-check or capability with no successor.

The two real reductions available are named and scoped: the four reader-path AI steps (§2.2), and `change draft` once `atticus upgrade` migrates a change's artifacts (§4). Both are tickets, not tidy-ups.

### 4. Retiring a command, when one is retired

When a command in §2.2 is retired, its words keep working:

- The word stays in the command catalogue with `legacy: true` and a new `retired` note naming its replacement, so `atticus commands --json`, the editors and `atticus help <command>` still find it.
- Running it runs the replacement and prints the note on stderr only when stderr is a terminal, so a script or an editor that parses stderr is unaffected (the D-cli addendum's rule).
- `atticus upgrade` rewrites the step in a metarepo's own files, and an old metarepo that still names the step keeps working through the alias.

Nothing is silently broken, and nothing in a runbook stops working.

### 5. The census makes the condition enforceable

An inventory is a promise, and a promise in a document is not a check. `pnpm check` now runs `scripts/check-surfaces.mjs`, beside the deny-list, core-neutral, portable-path, dependency and docs checks: a census of every surface a person meets, counted and named.

- The command line's distinct commands (223), read from the help text, which is the catalogue's own source (ADR 0096), and the twelve at the top.
- The app's pages (52), by id and in order, and — the part that matters — that each one has a component in the registry. A page whose component goes missing does not fail; it quietly renders the "being built" note. The census fails instead.
- VS Code's views (7) and palette commands (43).
- IntelliJ's tool-window tabs (9), read from `Copy.kt`, so the Kotlin half is covered by the same check without a Gradle build.

A number that grows needs nothing. A name that disappears fails the build, and the way to pass is a deliberate line in that file recording what was retired, the ADR that decided it and what does the job instead. The census was written before this ADR's text and proved against a real loss: removing one page's component from the registry fails it, naming the page.

This is the mechanism the product owner's condition needs. Without it, "nothing should break and we shouldn't lose UI functionality and depth" is checked by whoever remembers to look.

## Consequences

- The package count is unchanged at 57. The two test-only merges that would cost nothing are scoped in §2.1 and wait on a measurement, not a decision.
- `pnpm check` gains the surface census (§5), and CLAUDE.md's definition of done names it.
- `turbo.json`'s `build` outputs gain `npm/**`. `packages/sdk/npm` is written by the SDK's build but was not a declared output, so a turbo cache hit left it missing and `packages/conformance/test/npm-layout.test.ts` failed on a clean checkout that reused the cache. Found while taking the baseline for this work.
- `docs/codebase-map.md` had its Packages table three times and `docs/build-status.md` its phase table twice — damage from the eleven merges of 2026-10-25/26. Both are repaired here; the duplication was invisible to `scripts/check-docs.mjs`, which checks links, ADR citations and commands, not structure.
- The inventory is the place a later session looks before deleting anything. A row that says Kept needs a new ADR to change.
- `docs/build-status.md` gains the two deferred tickets with their surfaces named.
