# v31 notes: corrections spread, and Learn from my corrections (ADR 0208)

What the shared files should say for the `b31/corrections` package (WP-04 then WP-03). The integrator copies these in; this builder did not edit `CHANGELOG.md`, `docs/build-status.md` or `docs/codebase-map.md`.

## CHANGELOG.md (beta.31, Added)

- **Every canvas correction spreads, or says why not (ADR 0208).** A pairing made on the canvas (Connect to…, an add or a redirect from a repo's box in Edit the map) spreads to the repo's loose and AI-paired calls like it, as a corrected AI pairing does, in one batch on Decided by AI with one Undo; the Apply's Undo takes those lines back too. A spread never re-points a call the join ties somewhere, a call a person paired, declined, re-pointed or answered, or pairs a call with a repo whose arrow a person deleted. A delete, a declaration, a declared arrow, a pairing to an outside system and a redirect's delete half say why they don't spread.
- **Learn from my corrections (ADR 0208).** `atticus rules learn` and the button on Map › Decided by AI: the assistant is handed every pairing a person made that no proven rule names, with its cited lines, and drafts reading rules for the repo type; each is re-read on every file it names, verified on its lines, and the estate join run with it; a rule the join itself draws the corrections from, moving no arrow a person set or deleted on either side of a re-read repo, is written active with its proof, for the repos it was proven on only; any other stays a draft saying why. A person's correction that goes stale in a file an active learned rule names refuses that repo's verify --write and Apply, naming both ways on (turn the rule off for the repo, or answer again). The button is held, saying why, where AI is off or copilot-acp isn't allowed.

## CHANGELOG.md (beta.31, Contracts)

- C6: reading rules schema version 2: a rule's optional `learned` (`corrections`, `by`, `at`, `run`, `proof: { repos, reread, reproduced }` or `why`); a learned rule is active only with its proof, and only for `proof.repos`. A version 1 file reads as it did; `migrateReadingRulesText` moves a file on by its number when Learn writes to it. beta.30 refuses a version 2 file whole: a team upgrades together.
- C4, additive (3.19.0's next minor): `POST /api/reading-rules/learn` (a local job; its result is `LearnCorrectionsResult`). Edit the map's job lines say what each change spread or why not. `docs/api/openapi.json` regenerated.

## docs/build-status.md

Every canvas correction spreads, and Learn from my corrections (2026-11-22; ADR 0208; WP-04 and WP-03 of the v31 plan; C6 reading rules schema 2, C4 additive). **Works:** a canvas pairing or redirect spreads by `deriveMatch` in the same Apply over loose and AI-paired calls only, never onto a repo whose arrow a person deleted, its own batch with one Undo on Decided by AI, the Apply's Undo taking its lines back; the other changes say why not; `atticus rules learn` and the Learn button: drafts from the person's pairings no proven rule names, a re-read of every file each rule names (500 at most), verified, then the estate join without the corrected calls' pairings; a rule active for the repos it was proven on when the join draws each correction itself and no call a person set or arrow a person deleted moves, else a draft with its reasons; `atticus rules activate` on a learned draft; a person's correction gone stale under a learned rule refuses verify --write (one hook in `verify-commands.ts`, `staleUnderLearned`). Tests: `cli/test/corrections-spread.test.ts`, `cli/test/learn-from-corrections.test.ts`, `core/test/reading-rules-v2.test.ts`, `ui/test/decisions-learn.test.tsx`, assertions in `cli/test/ui-api-map-edits-pair.test.ts`. **Open:** Learn learns from pairings only; no real-model run of Learn yet; a spread's lines are recorded as the person's rule, not "Detected by AI"; no one command switches every proven rule back to draft; `POST /api/links/connect` without `preview` doesn't spread; two deletes in one second share a group in Deleted links (beta.28's).

## docs/codebase-map.md

- `packages/core/src/schema/reading-rules.ts`: `LearnedFrom`, schema version 2, `migrateReadingRulesText`.
- `packages/cli/src/ai-decide.ts`: `spreadPairing` (a canvas pairing's spread), `planPairSpread` (the spread loop shared with `correctDecision`), `ONLY_THIS_ARROW`, `onlyThisArrow`, `deletedPairs`, `deletedBlocks`.
- `packages/cli/src/catalog-build-commands.ts`: `applyMapEdits` runs each pairing's spread after the changes are saved, before the one build.
- `packages/cli/src/learn-corrections.ts` (new): `learnFromCorrections`, `learnRefusal`, `rulesLearnCommand` (`atticus rules learn`).
- `packages/cli/src/rules-commands.ts`: `rereadWith`, `rereadPrompt` (the re-read `rules try` and Learn share); `rules activate` on a learned draft.
- `packages/cli/src/reading-rules.ts`: `effectiveRules` gives a learned rule only to the repos it was proven on.
- `packages/cli/src/ui-api-decisions.ts`: `uiLearnRoutes`, `POST /api/reading-rules/learn`.
- `packages/ui/src/screens/map/Decisions.tsx`: `LearnPanel`, `LearnResultView`.

## For the integrator

- `packages/cli/src/main.ts` (help line and `rules learn`), `docs/guide/commands.md` (one line), `packages/ui/src/copy.ts` (`decisions.learn`) carry only this package's lines.
- `packages/core/src/api.ts`: `LearnCorrectionsResult`, its route in the registry, the schema list and a version-history line; no `API_VERSION` change was made here (bump once at integration).
- `scripts/check-surfaces.mjs`: 286 commands after merging map tools (both add one).
- `docs/api/openapi.json` was regenerated from this branch; regenerate it again after merging the wave.
- `packages/cli/src/newer-guard.ts`: `POST /api/reading-rules/learn` is guarded.

## Found while building (read only)

- A deleted arrow can be drawn again before this PR too: Delete this link writes a curated suppress of each Interface id, and an id is a hash of caller, callee, method and normalised path (`interfaceId`, `packages/core/src/identity.ts:42`) with no suppress of the pair anywhere in the build, so any read that changes a call's or an entry's path (a person's re-map, a code change read again) draws the pair through a new, unsuppressed Interface; ADR 0208 refuses that only in files an active learned rule names, and a pair-level suppress is the general fix, out of v31.
