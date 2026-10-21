# 0082. The scan's AI verify step, and the scan proposal file

- Status: accepted (pending review by the product owner)
- Date: 2026-10-21
- Builds on: ADR 0074 (the AI reads; every fact cites its code), ADR 0075 (scan settings per repo), ADR 0076 (client base URLs), ADR 0078 (questions as files), ADR 0080 (scanner plugins)

## Context

ADR 0074 runs a scan as AI → deterministic → AI. Step 4 is the last AI: the assistant compares what the scan recorded with its own reading of the code, and every disagreement goes back to step 2 (customise the scanner) or step 5 (ask a person). `atticus scan survey` (ADR 0075) is the first AI step. Nothing did step 4: a reader that misread the code, or a setting the survey didn't draft, only showed up on the bench, where a person had written the reference.

## Decision

1. **`atticus scan verify <repo> [--attempts 3] [--resume run] [--mode m] [--json]`.** The assistant (any AI runtime: hand-off by default) gets the repo's records from the last scan, grouped as entry points, calls, tables and deployments, each with its id and file:line; the repo's folders; its scan settings; and this step's questions on file (answered ones to follow, open ones not to ask again). It answers with one YAML document:

   ```yaml
   missed: # in the code, not in the records
     - kind: entry-point # call | table | deployment | other
       method: GET
       name: /tasks-api/tasks/archive # as the scan should record it
       at: "src/main/java/forge/tasks/ArchiveHandler.java:8"
       says: '"/tasks/archive"' # exactly as written on that line
       why: the Forge web framework routes it; no reader reads @ForgeRoute
       fix: { reader: "read @ForgeRoute(method, path) as an HTTP entry point" }
   wrong: # records the code doesn't support
     - record: forge-tasks.get.16999009ee
       at: "src/main/resources/application.properties:2"
       says: /tasks-api
       why: the context path is in front of every entry point
       fix:
         {
           settings:
             {
               prefixes:
                 [
                   {
                     paths: ["src/main/java/**"],
                     prefix: /tasks-api,
                     why: context path,
                     at: "src/main/resources/application.properties:2",
                     value: /tasks-api,
                   },
                 ],
             },
         }
   confirmed: [forge-tasks.post.16999009ee, forge-tasks-db.task]
   ```

   A fix is exactly one of `settings` (exclude, prefixes and clients entries, ADR 0075 and 0076), `question` (a question draft, ADR 0078) or `reader` (what a built-in reader or a scanner plugin must read differently, in plain words).

2. **Deterministic checks, each item on its own.** The cited line exists and contains `says` (the citation helper of the scan settings, `citedLine`); a missed entry point or call is named on its line (the last fixed segment of its path, or its method, as in `@GetMapping`), and a missed table by its name; a missed fact the scan already has is refused; a wrong or confirmed record must be one of this repo's records, and not both; a settings fix passes the survey's checks (schema, citations, globs that match files); a question's evidence lines exist. An answer with any failure is handed back with the failures. On the last attempt the failing items are left out and listed; the rest are kept.

3. **Results, never the catalog.**
   - `proposals/scan/<repo>.yaml` (schema `ScanVerifyProposal`, version 1; `.atticus/proposals/` in a repo adopted in place): the settings entries to accept, merged with an earlier proposal's and leaving out entries the repo's settings already hold; the latest run's missed and wrong items (a wrong item keeps the record's kind, method and name, for scoring); the confirmed records as `verified`; the question ids; and when a person last accepted.
   - Questions go to `questions/` with step `scan-verify` and rerun `atticus scan verify <repo>`; the same question is never written twice.
   - `reader` items go to `proposals/scan/<repo>.findings.md`, one plain sentence each.
   - `atticus scan verify <repo> --accept` checks the proposal's settings entries again against the code and merges them into `org-pack/scan/<repo>.yaml`, records who accepted (the Git user, ADR 0073, or `--by`) and when, and empties the proposal's settings. The org-pack file goes through a pull request like any other change. Nothing is merged when a check fails.

4. **Agreement raises confidence through the verified list only.** Each verified entry is `{ record, at: path:line, line: <12 hex of the SHA-256 of the line's trimmed text> }`, pinned to the record's first evidence. `catalog/generated` is not rewritten. A later scan will read the verified list of each repo's proposal and, for a record whose id is in it and whose cited line still hashes the same at the scanned commit, add evidence that the AI confirmed it (and raise `confidence` where the record's rules allow). A changed line drops the confirmation, so only facts whose code is unchanged stay confirmed (ADR 0074: a changed file invalidates only the facts that cite it). That reading is not built yet.

5. **The bench measures the verifier.** `atticus bench verify [--repo id] [--batch n] [--mode m]` adopts and scans each fetched bench repo (with its saved settings), runs `scan verify`, and keeps the proposal and findings in `<cache>/verify/`. `atticus bench run` then scores them against the reference: a flagged miss agrees when the reference has the fact; a flagged wrong record agrees when the reference doesn't have the record's fact. Only kinds the reference covers are scored. It prints the counts and the verifier's precision per repo, and puts them in `--json` as `verifier`.

## Consequences

- One new metarepo file kind (`proposals/scan/<repo>.yaml`, plus the findings Markdown); no existing file, record or call changes, so no migration. `ScanVerifyProposal` is zod in `@maycombhq/core`; it is not yet in `atticus schema export`.
- The `--accept` flag is new on the command line.
- Not built: the later scan reading the verified list (above); handing "reader" items to a plugin change automatically (a person or the assistant starts that change, ADR 0080); recall of the verifier on the bench (how many of the scan's true misses it flags); `scan verify` across every repo in one command; an app screen for the proposal.
- Tests use the mock runtime on `fixtures/scan-verify` and on the bench's invented Forge ledger; no test calls a model or the network.
