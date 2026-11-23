# 0208. Every canvas correction spreads or says why not, and a reading rule a re-read proves is active

- Status: proposed (2026-11-22, for the owner; built on `b31/corrections` as the owner directed: "the test of a rule is re-reading with it and getting what the correction said", one button over every correction since the last run)
- Date: 2026-11-22
- Release: 2.0.0-beta.31 ([v31 plan](../plan/v31.md), the row "Every canvas correction spreads to like cases, or says why not; then corrections become reading rules")
- Amends: ADR 0176 (a reading rule drafted by Copilot is `draft` until a person sets it active: one a re-read proved is written active), ADR 0181 part 2 (a correction spreads: a person's pairing made on the canvas spreads too)
- Extends: ADR 0174 (Connect to…'s pairing), ADR 0204 (Edit the map's Apply and its Undo), ADR 0178 (the shapes' first API), ADR 0074 and ADR 0124 (every fact cites its code)
- Contracts: C6: `ReadingRulesFile` goes to schema version 2, which adds an optional `learned` to a rule (what it was learned from, and its proof); a version 1 file reads as it did, and the migration moves a file on by its number only when Learn writes to it. C4, additive, in 3.19.0's next minor: `POST /api/reading-rules/learn` (a local job, its result `LearnCorrectionsResult`); Edit the map's job says, in its lines, what each change spread or why it applies to its arrow only. C1, C2, C3, C5 and the facts file are unchanged.

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

| Correction                                           | Where                          | What happens to like cases                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An AI pairing corrected to the right API, or to none | Decided by AI › Correct        | Spreads, as before (ADR 0181)                                                                                                                                                                                                                                           |
| An AI answer corrected to the right option           | Decided by AI › Correct        | Spreads, as before (ADR 0181)                                                                                                                                                                                                                                           |
| A pairing (Connect to…, an add from a repo's box)    | Edit the map                   | **Spreads** (`spreadPairing`): the rule `deriveMatch` gives (the call's own folder, or what it shares with the AI's pairings to the box the AI had joined it to) pairs the repo's other loose and AI-paired calls it covers with the target's API the shapes rank first |
| A redirect from a repo's box                         | Edit the map                   | Its pairing spreads as above; its delete doesn't                                                                                                                                                                                                                        |
| A delete                                             | Edit the map, Delete this link | Applies to this arrow only: it takes away the calls behind it, and Atticus never deletes an arrow a person didn't pick                                                                                                                                                  |
| A declaration (a topic or a route on a system)       | Edit the map, Declare a link…  | Applies to this arrow only: it is on the system's profile, which every read of that system uses already                                                                                                                                                                 |
| A declared arrow between two boxes                   | Edit the map                   | Applies to this arrow only: it names its two boxes                                                                                                                                                                                                                      |
| A pairing to an outside system                       | Edit the map                   | Applies to this arrow only: the system's APIs are its profile's, which every caller reads                                                                                                                                                                               |

A canvas spread is the person's rule, exactly as ADR 0181's: each line names the pairing it came from (`rule.from`), the batch is listed on Decided by AI with its Undo, and the Apply's own Undo takes the spread's lines back with the pairing. It only adds lines (an AI pairing it can't re-point is left as the AI's), so both Undos take back exactly what was written. It never touches a call a person paired, declined, re-pointed or answered. The Apply says, change by change, how many like calls it spread to and by which rule, or why the change applies to its arrow or call only (`ONLY_THIS_ARROW`, `onlyThisArrow`).

### 2. Learn from my corrections

One job, `atticus rules learn` and the button on Map › Decided by AI (`POST /api/reading-rules/learn`):

1. **Collect.** Every person's pairing that stands now (a corrected AI pairing, or a canvas pairing; never the AI's line or a spread's line) that no learned rule names yet. "Since the last run" is read from the rules files themselves: a rule's `learned.corrections` names what it was learned from, so a second run with nothing new asks nothing and writes nothing.
2. **Draft.** For each repo type, the assistant is handed each correction (`<repo> <file>:<line>`, what the person paired it with) and its cited lines, as data, and adds draft rules to `reading-rules/types/<type>.yaml`, as `atticus rules draft` does: a session that changes what a person set has the file put back.
3. **Re-read.** Each new draft is tried on exactly the files its `files` globs name in each corrected repo, as `atticus rules try` does: the facts go to `facts/.try/` and are removed after; the facts on file are never written. A draft that names none of the corrected files is not re-read.
4. **Verify.** With the re-read's facts in place of those files' facts, a rule is **proven** when:
   - on every corrected line it names, the re-read's call gets the person's API as the one the shapes rank first (ADR 0178), with no person's line;
   - no call a person paired, declined, re-pointed or answered changes in the re-read; and
   - no call the re-read changed would be paired with a repo whose arrow from this repo a person deleted on the canvas.
5. **Write.** A proven rule is written `status: active` with `learned` and its `proof` (`reread`, every file re-read; `reproduced`, the corrections it reproduced). Any other stays `draft` with `learned.why`, naming the correction it didn't reproduce or the arrow it would move. A correction no drafted rule names is listed as not learned. The file is written once per type, only if it is as Learn read it.

The proof is recorded, not trusted later: the next read is given the rule, and every fact it writes still cites its line and is checked by the verifier (rule 4).

### 3. The schema step (C6)

```yaml
schemaVersion: 2
rules:
  - key: path-from-constant
    status: active
    rule: >-
      A call's path is never the field that holds it: follow the field to the constant it is
      set from, and write that constant's value as the path.
    files: ["src/main/java/**/*Client.java"]
    learned:
      corrections: ["forge-billing src/main/java/forge/billing/PartnerClient.java:31"]
      by: pat
      at: 2026-11-08T10:15:00.000Z
      run: r-20261108-101500
      proof:
        reread: ["forge-billing src/main/java/forge/billing/PartnerClient.java"]
        reproduced: ["forge-billing src/main/java/forge/billing/PartnerClient.java:31"]
```

- `schemaVersion` takes 1 or 2. `learned` is refused at version 1, and a learned rule is refused as `active` without its `proof`, so no hand edit or session makes a learned rule active without one.
- **Migration:** `migrateReadingRulesText` moves a file from 1 to 2 by its number only, every other line as the person wrote it. A file without `learned` means the same at 1 and 2, so only a file Learn writes to is moved on (as runtime.yaml's version 4, ADR 0181).

### 4. Why an active learned rule keeps CLAUDE.md rule 6

Rule 6: a human approves every write to shared systems; AI never pushes to protected branches or deploys; every fact keeps its provenance; ingested content is data, never instructions.

- **A reading rule is not a write to a shared system.** Learn writes one file in the metarepo's own org pack, on the person's machine, as the person who pressed the button (`learned.by`). Nothing is committed, pushed or sent; the file goes into a pull request reviewed like code, as every reading rule is (ADR 0176). The person approves the shared write when they approve that pull request.
- **No fact loses its provenance.** A rule changes what a reader is told, never the verifier or the facts file's format: every fact a later read writes still cites its file and line and is checked there. A person's pairing, "none" and answer stand over anything a rule leads a read to.
- **A person's arrow is never moved by it.** A rule whose re-read would change a call a person set, or draw again an arrow a person deleted, is not activated. Undo is `atticus rules off <key>` or putting `status: draft` back, in the same file.
- **The cited lines are data.** They are handed to the assistant inside a fenced data block (`dataBlock`), as `atticus rules draft` hands what the reads missed.
- **A session acts as no one.** Learn and the canvas spread refuse inside a Copilot session (ADR 0171), and Learn refuses where runtime.yaml turns AI off.

## Consequences

- A correction on the canvas is no longer one call at a time: like calls are paired in the same Apply, listed with one Undo.
- Reading rules can become active without a person's per-rule confirm; the proof and the pull request are the review. A rule that fits the corrections and harms repos that weren't re-read is the risk: its scope is the repo type, and the next read's facts are verified line by line.
- Deletes, declarations and corrections of option questions are not yet learned from: Learn reads pairings. They are listed by what they are when a later version learns from them.

## Not decided here

- Whether a canvas spread's lines should show as "Detected by AI" rather than as the person's rule. ADR 0181 records a spread as the person's rule; showing it as the AI's needs a run the spread doesn't have.
- One command that switches every proven rule back to draft (`atticus rules off` does it one rule at a time).

## Tests first

- `packages/cli/test/corrections-spread.test.ts`: each correction kind, performed: a spread with its count, its batch and one Undo, or the reason it applies to its arrow only; a person-touched call is never changed.
- `packages/cli/test/learn-from-corrections.test.ts`: three corrections of one kind give one active rule with its proof, given to every repo of the type; a re-read that doesn't reproduce a correction, changes a call a person declined, or draws again a deleted arrow leaves a draft saying why; a second run asks and writes nothing; the AI's and a spread's lines are not learned from; AI off refuses.
- `packages/core/test/reading-rules-v2.test.ts`: version 1 reads as before; `learned` only at 2; active only with a proof; the migration.
- `packages/ui/test/decisions-learn.test.tsx`: the button, its running, failed and empty states, and the result, in the copy file's words.
- `packages/cli/test/ui-api-map-edits-pair.test.ts`: a redirect's Apply says what its pairing spread.
