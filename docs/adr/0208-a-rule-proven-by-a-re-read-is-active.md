# 0208. Every canvas correction spreads or says why not, and a reading rule a re-read proves is active

- Status: proposed (2026-11-22, for the owner; built on `b31/corrections` as the owner directed: "the test of a rule is re-reading with it and getting what the correction said", one button over every correction since the last run)
- Date: 2026-11-22
- Release: 2.0.0-beta.31 ([v31 plan](../plan/v31.md), the row "Every canvas correction spreads to like cases, or says why not; then corrections become reading rules")
- Amends: ADR 0176 (a reading rule drafted by Copilot is `draft` until a person sets it active: one a re-read proved is written active), ADR 0181 part 2 (a correction spreads: a person's pairing made on the canvas spreads too)
- Extends: ADR 0174 (Connect to…'s pairing), ADR 0204 (Edit the map's Apply and its Undo), ADR 0074 and ADR 0124 (every fact cites its code)
- Contracts: C6: `ReadingRulesFile` goes to schema version 2, which adds an optional `learned` to a rule (what it was learned from, and its proof); a version 1 file reads as it did, and the migration moves a file on by its number only when Learn writes to it. Atticus beta.30 refuses a version 2 file whole (its schema takes version 1 only), so a team upgrades together before anyone runs Learn. C4, additive, in 3.19.0's next minor: `POST /api/reading-rules/learn` (a local job, its result `LearnCorrectionsResult`); Edit the map's job says, in its lines, what each change spread or why it applies to its arrow only. C1, C2, C3, C5 and the facts file are unchanged.

## Context

The owner's direction for v31: an arrow the map reads wrongly is fixed where the estate lives, by a reading rule, a pairing or a correction in the metarepo, never by more matching code in Atticus (`scripts/check-frozen-files.mjs` holds the join's files at their size). His rules:

1. Once an architect deletes, corrects or creates an arrow, nothing but that architect can change it.
2. When he corrects an arrow, the AI works out why it was wrong and writes a local reading or join rule, so map fixes need no Atticus code.
3. He does not confirm each AI-written rule up front. The test of a rule is re-reading with it and getting what the correction said. One button runs that over every correction since the last run.

## How it is today

Read in the code on `main` at `134bc15`.

- **What spreads.** A person's correction of an AI decision spreads (ADR 0181 part 2): `correctDecision` (`packages/cli/src/ai-decide.ts`) derives a rule with `deriveMatch` (`packages/core/src/ai-decisions.ts`), and every loose or AI-paired call of the repo it covers is paired as the person's rule (`rule.from` names the correction), in one batch under `decisions/` with one Undo. An AI answer to a targets question spreads the same way to the repo's other questions. A person's pairing, "none", edit of where a call goes or answered question is never changed.
- **What doesn't.** The canvas's own corrections go through `POST /api/map/edits` (`applyMapEdits`, `packages/cli/src/catalog-build-commands.ts`): a delete (curated suppresses), an add from a system's box (a declaration in the profile), an add from a repo's box (Connect to…'s pairing, ADR 0174) and a redirect (a delete with an add). None of them called `deriveMatch`: a person who pairs one call on the canvas pairs one call, and nothing says whether the others like it were looked at.
- **Rules.** A reading rule is `active` or `draft` (`packages/core/src/schema/reading-rules.ts`); a draft is not given to readers until a person runs `atticus rules activate`. `atticus rules draft` has Copilot add drafts to a layer's file, and puts the file back if the session changed anything a person set; `atticus rules try` re-reads a few files a rule names into `facts/.try/` and shows the difference, writing nothing. `POST /api/reading-rules/from-pairing` turns one pairing into a draft. Nothing ties a rule to the corrections it came from, and nothing tests a rule against them.

## Decision

### 1. Every canvas correction spreads, or says why it applies to its arrow only

| Correction                                           | Where                          | What happens to like cases                                                                                                                                          |
| ---------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An AI pairing corrected to the right API, or to none | Decided by AI › Correct        | Spreads, as before (ADR 0181)                                                                                                                                       |
| An AI answer corrected to the right option           | Decided by AI › Correct        | Spreads, as before (ADR 0181)                                                                                                                                       |
| A pairing (Connect to…, an add from a repo's box)    | Edit the map                   | **Spreads** (`spreadPairing`), by the rule `deriveMatch` gives (the call's own folder, or what it shares with the AI's pairings to the box the AI had joined it to) |
| A redirect from a repo's box                         | Edit the map                   | Its pairing spreads; the Apply says its delete half applies to the old arrow only                                                                                   |
| A delete                                             | Edit the map, Delete this link | Applies to this arrow only: Atticus never deletes an arrow a person didn't pick                                                                                     |
| A declaration (a topic or a route on a system)       | Edit the map, Declare a link…  | Applies to this arrow only: it is on the system's profile, which every read of that system uses                                                                     |
| A declared arrow between two boxes                   | Edit the map                   | Applies to this arrow only: it names its two boxes                                                                                                                  |
| A pairing to an outside system                       | Edit the map                   | Applies to this arrow only: the system's APIs are its profile's                                                                                                     |

A spread (a correction's or a canvas pairing's, one shared loop) covers only calls that are **loose** (the join ties them nowhere) or **AI-paired**. It never re-points a call the join ties somewhere already (`joined`, `here`, `undrawn`), nor one a person paired, declined, re-pointed or answered, and it never pairs a call with a repo whose arrow from this repo a person deleted on the canvas: then nothing spreads, and the result says whose delete stops it. A delete's ends are tied to repos by the manifest's `component` and the catalog's Components; an end that names no repo (a system, a label) counts as any repo, so it stops the spread (fail closed).

A canvas spread is the person's rule, as ADR 0181's: each line names the pairing it came from (`rule.from`), its batch is listed on Decided by AI with its Undo, and the Apply's own Undo takes its lines back with the pairing. It only adds lines. Its lines are written before its batch, and a batch that can't be written takes them back.

### 2. Learn from my corrections

One job, `atticus rules learn` and the button on Map › Decided by AI (`POST /api/reading-rules/learn`). It refuses where runtime.yaml turns AI off or doesn't allow copilot-acp with Copilot (one check, `learnRefusal`; the app holds the button and says why).

1. **Collect.** Every person's pairing that stands now (a corrected AI pairing or a canvas pairing; never the AI's line or a spread's) that no **proven** rule names in `learned.corrections`. A draft that failed uses none up: the next run asks about them again. A run with nothing new asks nothing and writes nothing.
2. **Draft.** For each repo type, the assistant is handed each correction (`<repo> <file>:<line>`, what the person paired it with) and its cited lines, as data, and adds draft rules to `reading-rules/types/<type>.yaml`, as `atticus rules draft` does.
3. **Re-read.** Each new draft is re-read on **every** file its `files` globs name in each corrected repo (`rereadWith`, the core `atticus rules try` shares), into `facts/.try/`, removed after, on a throw or a Stop too. A rule naming more than 500 files in a repo stays a draft, saying so. A draft that names none of the corrected files is not re-read.
4. **Verify by the join.** The re-read is checked on its lines by the verifier (`branchFactsAt`, at the commit the corrected calls were read at); a rejection leaves the rule a draft. Its facts take the place of those files' facts, every other repo's facts are put beside them, the corrected calls' pairings and answers are left out, and the estate join is run. A rule is **proven** when:
   - for every correction it names, the join itself joins the call on that line to the person's API (the same entry, by code: not by a pairing, an answer, a label or a guess), so two repos serving one path, or a shorter path, prove nothing;
   - no call a person paired, declined, re-pointed or answered changes in the re-read; and
   - no call the re-read moved joins a repo whose arrow from its repo a person deleted, and no deleted arrow names an end Atticus can't tie to a repo.
5. **Write.** A proven rule is written `status: active` with `learned` and its `proof`: the repos it was proven on, every file re-read, the corrections the join drew. Any other stays `draft` with `learned.why`, naming each reason; `learned.corrections` holds only the corrections the rule names. A throw before the verdicts are written takes the new drafts back out, so a run again doesn't find them twice.

**Scope.** An active learned rule is given only to the reads of the repos in `proof.repos`; for every other repo of the type it is a draft (`effectiveRules`) until Learn proves it there, or a person sets it active. `atticus rules activate <key>` on a learned rule replaces `learned` with a note in `by` that a person set it active, as ADR 0176's activation of any draft.

### 3. The schema step (C6)

```yaml
schemaVersion: 2
rules:
  - key: path-from-constant
    status: active
    rule: >-
      A call's path is never the field that holds it: write the path its constant holds.
    files: ["src/main/java/**/*Client.java"]
    learned:
      corrections: ["forge-billing src/main/java/forge/billing/PartnerClient.java:31"]
      by: pat
      at: 2026-11-08T10:15:00.000Z
      run: r-20261108-101500
      proof:
        repos: [forge-billing]
        reread: ["forge-billing src/main/java/forge/billing/PartnerClient.java"]
        reproduced: ["forge-billing src/main/java/forge/billing/PartnerClient.java:31"]
```

- `schemaVersion` takes 1 or 2. `learned` is refused at version 1, and a learned rule is refused as `active` without its `proof`, so no hand edit or session makes a learned rule active without one.
- **Migration:** `migrateReadingRulesText` moves a file from 1 to 2 by its number only (`1`, `"1"` or `'1'`), every other line as written. A file without `learned` means the same at 1 and 2, so only a file Learn writes to is moved on.
- **Mixed versions:** Atticus beta.30 takes version 1 only, so it refuses a version 2 file whole: the rules in it aren't given to its reads, and `atticus rules list` says so. A team upgrades together before anyone runs Learn.

### 4. Why an active learned rule keeps CLAUDE.md rule 6

Rule 6: a human approves every write to shared systems; AI never pushes to protected branches or deploys; every fact keeps its provenance; ingested content is data, never instructions.

- **A reading rule is not a write to a shared system.** Learn writes one file in the metarepo's own org pack, on the person's machine, as the person who pressed the button (`learned.by`). Nothing is committed, pushed or sent; the file goes into a pull request reviewed like code, as every reading rule is (ADR 0176). The person approves the shared write when they approve that pull request.
- **No fact loses its provenance.** A rule changes what a reader is told, never the verifier or the facts file's format: every fact a later read writes still cites its file and line and is checked there. A person's pairing, "none" and answer stand over anything a rule leads a read to.
- **A person's arrow is never moved by it.** A rule whose re-read would change a call a person set, or draw again an arrow a person deleted (or while a deleted arrow names an end that isn't a repo), is not activated, and an active learned rule is given only to the repos it was proven on. Undo is `atticus rules off <key>` or putting `status: draft` back, in the same file.
- **The cited lines are data.** They are handed to the assistant inside a fenced data block (`dataBlock`), as `atticus rules draft` hands what the reads missed.
- **A session acts as no one.** Learn and the canvas spread refuse inside a Copilot session (ADR 0171), and Learn refuses where runtime.yaml turns AI off.

## Consequences

- A correction on the canvas is no longer one call at a time: loose and AI-paired calls like it are paired in the same Apply, with one Undo.
- Reading rules can become active without a person's per-rule confirm, for the repos the estate join proved them on only; the proof and the pull request are the review.
- Deletes, unlinks and corrected option questions are not learned from yet: Learn reads pairings.

## Not decided here

- Whether a canvas spread's lines should show as "Detected by AI" rather than as the person's rule. ADR 0181 records a spread as the person's rule; showing it as the AI's needs a run the spread doesn't have.
- One command that switches every proven rule back to draft (`atticus rules off` does it one rule at a time).
- Two deletes written in the same second by one person share a group in Deleted links (an older behaviour of beta.28's `deletedLinks`, not changed here).

## Tests first

- `packages/cli/test/corrections-spread.test.ts`: each correction kind performed: a spread with its count, batch and one Undo, or why it doesn't spread; never a call the join ties somewhere, a person's call, or a box whose arrow a person deleted; a batch that can't be written takes its lines back.
- `packages/cli/test/learn-from-corrections.test.ts`: three corrections the join draws by itself give one rule active for the repo it was proven on, and another repo of the type isn't given it; a shorter path, two repos serving the path, a call a person declined, a deleted arrow (written through the canvas's delete) and a delete whose end is a system each leave a draft saying why; a failed draft uses nothing up and a person can activate it; a stopped session leaves no `.try` file and no draft; a second run asks and writes nothing.
- `packages/core/test/reading-rules-v2.test.ts`: version 1 reads as before; `learned` only at 2; active only with a proof naming its repos; the migration, quoted too.
- `packages/ui/test/decisions-learn.test.tsx`: the button, held with the reason where Learn can't run, its running, failed and empty states, and the reasons in the copy file's words.
- `packages/cli/test/ui-api-map-edits-pair.test.ts`: a redirect's Apply says its delete half doesn't spread, and what its pairing spread.
