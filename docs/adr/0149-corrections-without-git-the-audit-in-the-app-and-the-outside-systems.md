# 0149. Corrections without git commands, the audit answered in the app, and the outside systems

- Status: accepted (pending review by the product owner)
- Date: 2026-11-01
- Builds on: ADR 0124 (facts, corrections and the estate join; addendum D-app), 0135 (This link is wrong), 0148 (the sample audit), 0130 and 0142 (a vendor's or another team's spec), 0024 (the local API, C4); build-status B1 (the app never runs commands); plan items C4, O4 and P3's follow-up

## Context

- **C4.** After Correct this or This link is wrong the app showed a `git add && git commit` line and `atticus verify <repo>`. A person who doesn't use git every day didn't know what else to add, which branch to make, or what the verify would do to the map. The product owner decided: the app shows the commands, it doesn't run them (B1 stands).
- **P3.** `atticus verify audit` was the only way to answer a sample audit (ADR 0148, Not done).
- **O4.** A vendor or another team's system appeared only as the far end of a link, a target question's option, or an impact's line: nowhere said everything about it at once.

## Decision

### 1. After a correction: one panel, the commands and a preview (C4)

After any correction the app writes, one panel (`CorrectionNext`, `ui/src/app/correction-next.tsx`, used by Correct this and This link is wrong) says the app wrote only the corrections file, shows the line it appended as written (`line`, new on the correction's result), and lists in order, each with a copy button:

1. `atticus verify <repo> --write`
2. `git switch -c correct/<repo>-<fact>`
3. `git add` with the exact files the write changes: the corrections file, the facts file, the verify report (and the rejected file when there is one), each catalog record file the write adds, changes or removes, and the repo's flows folder, map folder and the questions folder when the write renders them.
4. `git commit -m "<repo>: a person's correction of <fact>, applied by atticus verify --write"`
5. `git push -u origin <branch>`
6. the pull request: `gh pr create`, `glab mr create` or `az repos pr create` for the Git host `runtime.yaml adapters.gitHost` names (configuration, rule 7); for another host, or none, words to open it by hand.

Then what that write will change, from `GET /api/facts/{repo}/preview`: the facts it leaves out (marked wrong, or rejected, with why) and edits (field by field, the line included); the links it adds, removes, changes and moves (one call, another callee), and those the repo no longer makes whose record stays, held by the callee's side, until that repo is written again; the catalog's counts; or that it writes nothing to the catalog because facts are rejected. It is a dry run of the command's own functions: `verifyInputsOf` (new, now what `atticus verify` reads too), `verifyFacts`, and `projectFactsIntoCatalog` (new, now what `writeFactsIntoCatalog` writes), in memory. The write first reads the repo's contract files in its checkout into `<repo>.contracts.yaml` (ADR 0151); the preview reads them with the same reader (`repoContractsOf`) and passes them in, so a Pact or OpenAPI file the repo gained or changed confirms the same links in both, and names the companion among the files the write changes. It keeps no read cache either (`projectFactsIntoCatalog` with `cache: false`): it writes nothing at all, not even under `.atticus/`. It compares with the catalog on disk, so it also shows anything else waiting to be written, and says so. No git runs: the checkout's HEAD is read from its `.git` files, and a HEAD past the facts' commit is said, since verify then reads the changed files' facts again and the preview doesn't. With no checkout the commands are still given and the preview says why there is none.

### 2. A sample audit answered in the app (P3's follow-up)

Map › Trust's Sample audit has Answer a sample. `GET /api/facts/{repo}/audit?seed&size` draws with `prepareAudit` (taken out of `atticus verify audit`, which now uses it), so the same seed and size give the same items as the command; each item comes with its cited lines read from the checkout, and any answer on file. GET writes nothing. `POST /api/facts/{repo}/audit` (`{ seed, size, answers }`) draws again and writes with the CLI's own `answerAudit` and `writeAudit`, as the signed-in person; an id not in that draw is refused, as the CLI refuses it. A wrong fact opens Correct this in place; a wrong link points to the canvas, where the link's This link is wrong is. The answer carries the `git` command; the app runs none.

### 3. The outside systems, one page each (O4)

Map › Outside systems (`#/outside?system=<id>`, linked from Systems, in Ctrl+K: an aside page, so the six's tabs are unchanged; the census counts 54 pages). For each system `outsideProfileSystems` gives (every vendor, and every system no estate repo belongs to), `GET /api/outside` says:

- **who calls it:** the catalog's Interfaces to it (their call lines, not their config lines), the estate join's `outside` list, and the calls `joinVendorOperations` lands on its spec, with the services whose calls reach the gateway route a forwarding call is under. Each says where it was seen.
- **which operations:** its newest intaken spec in `inputs/` (the one no later version supersedes), each operation with how many of those calls reach it.
- **which calls match nothing in its spec,** and those two operations answer equally.
- **its open questions:** naming it (in the question or an option) or citing a line one of its calls is on.
- **with no spec,** how to add one: `atticus intake add`, `atticus intake list`, `atticus triage`.

Every system's direct calls are matched to its spec here (`boundary: internal` given to the vendor match for all), a vendor's too: ADR 0142 leaves a vendor's direct calls to the gateway for the impact, but who calls a system is this page's point. The impact and the prototype comparison are unchanged.

## Contract notes

- **C4:** 2.42.0, additive: `GET /api/facts/{repo}/preview` (`VerifyPreviewView`), `line` on `FactCorrectionResult`, `GET` and `POST /api/facts/{repo}/audit` (`AuditSampleView`, `AuditAnswerRequest`, `AuditAnswerResult`), `GET /api/outside` (`OutsideView`). `docs/api/openapi.json` and `docs/spec` regenerated.
- **The facts file, C1, C2, C3, C5, C6:** unchanged. The audit file's schema is unchanged.

## Consequences

- A person can go from a correction to a pull request without knowing git, and sees what the map will do before running anything.
- The preview and the write can't drift: they call the same functions on the same inputs (the repo's contract files read from the checkout in both), and a test checks that every file the write changes is one the add step names, one with a repo that gains a Pact file among them, and that the preview leaves every file as it was, `.atticus/` included.
- An audit can be answered by a person who never opens a terminal; the CLI and the app write the same file the same way.

**Not done here:**

- The preview isn't read again when the person runs the write: the panel shows what the write will do, then Trust and the canvas follow the files as before.
- `git add` names folders for the flows, the map and the questions, not each file in them: what the map renders isn't worked out in the dry run.
- The audit's link items open the canvas on the caller's repo, not the link's own This link is wrong form.
- The Outside systems page shows no version history (that is `atticus intake impact`), and doesn't draw the system.
