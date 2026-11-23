# v31 notes: corrections spread, and Learn from my corrections (ADR 0208)

What the shared files should say for the `b31/corrections` package (WP-04 then WP-03). The integrator copies these in; this builder did not edit `CHANGELOG.md`, `docs/build-status.md` or `docs/codebase-map.md`.

## CHANGELOG.md (beta.31, Added)

- **Every canvas correction spreads, or says why not (ADR 0208).** A pairing made on the canvas (Connect to…, an add or a redirect from a repo's box in Edit the map) spreads to the repo's like calls as a corrected AI pairing does: the rule `deriveMatch` gives pairs the other loose and AI-paired calls it covers with the target's API the shapes rank first, as the person's rule, in one batch on Decided by AI with one Undo; the Apply's Undo takes those lines back too. A person's pairing, "none", re-pointing or answer is never changed. A delete, a declaration, a declared arrow and a pairing to an outside system say, in the Apply's lines, why they apply to their arrow only.
- **Learn from my corrections (ADR 0208).** `atticus rules learn` and the button on Map › Decided by AI: the assistant is handed every pairing a person made since the last run, with its cited lines, and drafts reading rules for the repo type; each is re-read on the files it names only; a rule whose re-read reproduces the corrections and moves no arrow a person touched is written active with its proof, any other stays a draft saying why. A second run with nothing new asks nothing and writes nothing.

## CHANGELOG.md (beta.31, Contracts)

- C6: reading rules schema version 2: a rule's optional `learned` (`corrections`, `by`, `at`, `run`, `proof: { reread, reproduced }` or `why`); a learned rule is active only with its proof. A version 1 file reads as it did; `migrateReadingRulesText` moves a file on by its number when Learn writes to it.
- C4, additive (3.19.0's next minor): `POST /api/reading-rules/learn` (a local job; its result is `LearnCorrectionsResult`). Edit the map's job lines say what each change spread or why not. `docs/api/openapi.json` regenerated.

## docs/build-status.md

Every canvas correction spreads, and Learn from my corrections (2026-11-22; ADR 0208; WP-04 and WP-03 of the v31 plan; C6 reading rules schema 2, C4 additive). **Works:** a canvas pairing or redirect spreads by `deriveMatch` in the same Apply, its own batch with one Undo on Decided by AI, the Apply's Undo taking its lines back; deletes, declarations, declared arrows and pairings to outside systems say why not; `atticus rules learn` and the Learn button: drafts from the person's pairings since the last run, a re-read of only the files each rule names, a rule active with its proof when it reproduces them and moves no arrow a person set or deleted, else a draft with why. Tests: `cli/test/corrections-spread.test.ts`, `cli/test/learn-from-corrections.test.ts`, `core/test/reading-rules-v2.test.ts`, `ui/test/decisions-learn.test.tsx`, an assertion in `cli/test/ui-api-map-edits-pair.test.ts`. **Open:** Learn learns from pairings only (not deletes, unlinks or corrected option questions); no real-model run of Learn yet; a spread's lines are recorded as the person's rule, not shown as "Detected by AI" (ADR 0208, not decided here); no one command switches every proven rule back to draft; `POST /api/links/connect` without `preview` (the dialog's write before ADR 0204, which the app no longer uses for a write) doesn't spread.

## docs/codebase-map.md

- `packages/core/src/ai-decisions.ts`: `ONLY_THIS_ARROW`, `onlyThisArrow` (ADR 0208, what each canvas correction does to like cases).
- `packages/core/src/schema/reading-rules.ts`: `LearnedFrom`, schema version 2, `migrateReadingRulesText`.
- `packages/cli/src/ai-decide.ts`: `spreadPairing` (a canvas pairing's spread), `planPairSpread` (the spread loop shared with `correctDecision`), `bestApiOf`.
- `packages/cli/src/catalog-build-commands.ts`: `applyMapEdits` runs each pairing's spread after the changes are saved, before the one build.
- `packages/cli/src/learn-corrections.ts` (new): `learnFromCorrections`, `rulesLearnCommand` (`atticus rules learn`).
- `packages/cli/src/ui-api-decisions.ts`: `uiLearnRoutes`, `POST /api/reading-rules/learn`.
- `packages/ui/src/screens/map/Decisions.tsx`: `LearnPanel`, `LearnResultView`.

## For the integrator

- `packages/cli/src/main.ts` (help line and `rules learn`), `docs/guide/commands.md` (one line), `packages/ui/src/copy.ts` (`decisions.learn`) carry only this package's lines.
- `packages/core/src/api.ts`: `LearnCorrectionsResult`, its route in the registry and the schema list; no `API_VERSION` change was made here (other packages of the wave also add to the local API: bump once at integration).
- `docs/api/openapi.json` was regenerated from this branch; regenerate it again after merging the wave.
- `packages/cli/src/newer-guard.ts`: `POST /api/reading-rules/learn` is guarded.
