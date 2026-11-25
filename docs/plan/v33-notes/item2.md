# v33 notes: item 2, writes that go past what they can (ADR 0210 part 3)

What the shared files should say for the `b33/item2-nonblocking` branch (PR #16), after its review. The integrator copies these in; this builder did not edit `CHANGELOG.md`, `docs/build-status.md` or `docs/codebase-map.md`.

## CHANGELOG.md (beta.33, Changed)

- **A person's write doesn't stop on what it can go past (ADR 0210 part 3).** `atticus verify <repo> --write`, `verify --all --write`, the app's Apply and the map's Apply now run `atticus upgrade --yes` first when one is owed (its own undo step), keep hand edits of the catalog as yours (curated, as `atticus catalog edits --curate` does) and write the removals the build lists, each said with what explains it, where they used to refuse. A removal nothing explains, a read that found nothing, an empty catalog, a newer Atticus and a `build.json` that doesn't read still refuse. A write that confirmed a plan or a count (the app's confirm, `--allow-removals`, `--discard-edits`) runs as asked, and `atticus catalog build` keeps every refusal. A round that refuses the same again stops (no loop), the removals are said only once the write wrote them, and an edit curate can't keep leaves the refusal standing with the decisions it did write said. `verify --all --write` stays one build and one undo step over a hand edit or a large removal.
- **A fact a re-read leaves out is kept while its files are unchanged (ADR 0210 part 3).** verify --write checks the last read's facts this read left out again and keeps those whose lines still hold in the catalog's slot (`catalog/sources/facts/<repo>.jsonl`) only, never in the facts file the read wrote; one whose file changed goes with the change, and is no rejection. The coverage, the commits said and the read's completeness are this read's alone (`verifyFacts`' `heldOver`).
- **verify --json says what the write went past (additive).** `kept: { facts: [ids], edits: n }`, `removed: [{ kind, id, explainedBy, reasons }]` and `upgraded: true`.

## CHANGELOG.md (beta.33, Fixed)

- `--approve`, and the digest's `--send`, are refused in a coding assistant's terminal (an approval is a person's, ADR 0210 part 7), and the app's and the commands' words no longer say `--approve <you>`: `--approve` takes no name (the Git user approves).

## docs/build-status.md

Writes that go past what they can (2026-11-24; ADR 0210 part 3; item 2 of `docs/plan/ai-first.md`). **Works:** `writeGoingOn` (`packages/cli/src/map-render-commands.ts`) around one repo's write, the many-repo write (`writeManyFactsIntoCatalog`) and the map's Apply build (`buildAfterDecisions` with `goPast`, curating under the lock it holds); an upgrade owed before the write (`runUpgradeFirst`, a held lock said as the upgrade stopping); the scope's refusal saved before the write and restored after one that went past (`refusalSaved`), so an earlier repo's refusal in verify --all keeps its standing line; kept facts out of the read's facts file, coverage and missing commits; verify's `--json` fields. Tests: `cli/test/write-goes-on.test.ts` (kept fact, its file changed and dropped, removals with reasons said once, hand edits kept in words and `--json`, unexplained removals and an unreadable `build.json` still refusing, the app's Apply route, the map's Apply, verify --all as one build and one undo copy, the rounds: no progress stops, the latest removals said once, an earlier refusal kept), `cli/test/upgrade-before-write.test.ts` (writes reached with a checkout, exit codes, `upgraded` in `--json`, the map's Apply `built`/`code`, an upgrade stopped by a held lock: one `not-tried` per change and "Nothing was saved and nothing was built."; the old-name decision check restored), `cli/test/upgrade-unresolved-ids.test.ts` (the go-past matches the direct upgrade: decision targets, loose ends), `verify/test/verify.test.ts` (`heldOver`), `cli/test/approve-person-only.test.ts` (`--send`), the property suite (`cli/test/properties`: the exemptions cover every person's write the model has, verify --write, the app's Apply and its stop after the result, and Connect to…'s pair and move, with no confirm; the model keeps their hand edits as curated as curate-edits does; 98 of 98 pass). **Open:** see below.

## docs/codebase-map.md

| What                                               | Where                                                                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A write that goes past a refusal (ADR 0210 part 3) | `packages/cli/src/map-render-commands.ts` (`writeGoingOn`, `goesPast`, `WentPast`, `writeFactsIntoCatalog`, `writeManyFactsIntoCatalog`, `writeFactsHooks.strict`) |
| The map's Apply going past                         | `packages/cli/src/catalog-build-commands.ts` (`buildAfterDecisions` `goPast`, `catalogBuild` `onRefused`, `catalogEdits` `held`, `applyMapEdits`)                  |
| The upgrade a write runs first                     | `packages/cli/src/upgrade.ts` (`runUpgradeFirst`, `upgradeBeforeWrite`)                                                                                            |
| Facts a re-read left out, kept                     | `packages/cli/src/verify-commands.ts` (`leftOutOfThisRead`, the kept split in `verifyCommand`), `packages/verify/src/verify.ts` (`VerifyOptions.heldOver`)         |
| A refusal gone past, out of the command's standing | `packages/cli/src/standing.ts` (`refusalSaved`, `refusalTakenBack`)                                                                                                |

## Words added (copy and help)

- "Kept N hand edit(s) of the catalog as yours (curated, as atticus catalog edits --curate does): … To discard instead: atticus catalog undo, then write again with --discard-edits N."
- "Removed N record(s) the new read no longer has (atticus catalog undo takes the write back):" with one line per removal and what explains it (not said by the map's Apply, whose build lists its removals itself).
- "Kept N fact(s) of the last read that this read left out, every file it cites unchanged: … To remove one, delete it on the map."
- "Ran atticus upgrade first, which this metarepo still needed (its own undo step: atticus catalog undo takes it back after this write's)." / "This metarepo needed atticus upgrade first, and it stopped:"
- The map's Apply, when the upgrade it runs first stops: "Nothing was saved and nothing was built."
- Help: `verify --write` "runs an upgrade owed first, keeps hand edits as yours and lists removals rather than stopping (ADR 0210)"; `--allow-removals` left out of verify's help.
- These words are in the command files, as the rest of verify's and the build's are; none is in the app's copy file.

## Open, for the next step

- What the write did to the metarepo before a final refusal (the upgrade it ran, the edits it curated, the decisions a partial curate wrote) is said even when the write ends refused, since those changes stand; only the removal lines wait for a round that wrote. The review asked for "said only when the final round wrote"; this keeps the part that is true either way.
- The map's Apply's knock-on removals of a teammate's pulled suppress are now written and listed (`ui-api-map-edits-review.test.ts` changed to say so) where they used to leave the build refused for Catalog builds. Bring back a link and the undo of an Apply still build strictly (`goPast` is the Apply's only).
- `atticus sync` (named by the ADR) is not wrapped here.
- `ui-api-reconnect.test.ts` has 4 failures on this branch before and after this change (not looked into).
- `apply-one-build.test.ts` (d) now runs strict: it tests the guard's own refusal and the per-repo fallback.
- The property model has no map's Apply of its own (its pair and move apply through verify --write); its exemptions cover `verify-write`, `apply-app`, `crash-after-result`, `pair`, `move` and `again` of them, with no confirm.
