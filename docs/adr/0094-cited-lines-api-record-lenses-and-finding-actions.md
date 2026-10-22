# 0094. One file's cited lines (`GET /api/cites`), record lenses, and acting on findings from VS Code

- Status: accepted (pending review by the product owner)
- Date: 2026-10-22
- Builds on: ADR 0093 (the VS Code sidebar, code links and CodeLens), ADR 0092 (the specs API), ADR 0074 (every fact cites its code)

## Context

ADR 0093 left three things not built:

1. The CodeLens read every flow of every spec to find a file's cited lines: 127 requests on NadiEngine, and more on a bigger estate.
2. Catalog records (endpoints, tables, interfaces…) cite lines too, but only flow steps had lenses.
3. A finding in the sidebar only opened its file. Acting on it (apply the fix, dismiss it, waive it, ask someone) meant going to the app or the command line.

## Decision

1. **`GET /api/cites?repo=<repo>&path=<file>` (C4, API 2.4.0)** gives each line of one file that a spec flow or a catalog record cites (`CiteList`).
   - For each line, the flow steps that cite it (the flow's repo, id and name, the step, counting the trigger as 0, its kind, and who confirmed it), and the records read from it (kind, id, name, the citation's source).
   - The server keeps an index of every citation. It builds the index when it starts, and again when the spec folders or the catalog change (their file count or newest change time, read on each call). One file then costs one lookup: on NadiEngine, 4.2 s to build and about 140 ms a file after.
   - It reads files only. A missing repo or path is a 400.
2. **CodeLens uses it.** One call per file, when the file is first shown, and again after Refresh or a change under `specs/`, `catalog/`, `openspec/` or `questions/`.
   - Each flow step on a line gets its own lens, as before.
   - The records on a line share one lens (`Atticus: Endpoint nadiengine-api.post-horoscope, GlossaryTerm term.horoscope`). It opens the record's YAML, or asks which record when there are several.
   - The setting `atticus.codeLens.records` leaves the record lenses out.
3. **Acting on a finding from the sidebar.** A finding has an "Act on the finding" button. It offers only what the critic allows (the same rules as `atticus finding`, naysayer `act.ts`):
   - an issue offers:
     - Apply the fix, when it carries a patch;
     - I fixed it by hand (with what changed);
     - Not relevant (with why);
     - Waive it, only for a blocking, waivable finding that doesn't come from a constitution rule (with why);
     - Ask someone.
   - a knowledge gap offers Ask its owner, or I wrote the fact in.

   Before a patch is applied, the extension shows the patch and asks for a yes. The action goes through the existing `POST /api/findings/{change}/{finding}/action`. The app records who acted, and refuses anything the rules don't allow, with its own words. A person picks every action; nothing is automatic.

4. **Contract change.** C4 gains one GET route and one schema, an addition: API 2.3.0 → 2.4.0, with no migration. No other contract changes.

## Consequences

- Opening a file costs one local call, however many flows the estate has. A line's lenses show both what flows through it and what the catalog read from it.
- A person can resolve the findings of a change without leaving the editor, under the same rules and with the same record as the app and the command line.
- The fingerprint walks the specs and catalog folders on each call (about 1,700 files on NadiEngine). On a much larger estate a file watcher in the server would be cheaper; it would publish the same `file.changed` events the app already reacts to.
- Not built: editing a finding's patch before applying it (Edit and apply with a patch); the app and `atticus finding … --edit` do that.
