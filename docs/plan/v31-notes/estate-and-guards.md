# v31 notes: the public estate, the size budget and the naysayers on

What this branch (`b31/estate-and-guards`) did, and what the shared files should say about it
when it merges. Rows of `docs/plan/v31.md`: "A public multi-service estate, facts stored, its
joined arrows scored offline in CI" and "A size budget for non-test source in CI; the
application-architect and security naysayers on at the design gate in new metarepos".

## CHANGELOG.md (2.0.0-beta.31)

- **A public estate is scored in CI.** `fixtures/oss-estate/` stores the verified facts of two
  public Apache-2.0 repos at pinned commits (`spring-petclinic-rest` `afc8fc1`,
  `spring-petclinic-angular` `7c9f1ab`), a minimal org pack and a hand-written list of the 31
  true arrows. `packages/cli/test/oss-estate-join.test.ts` builds the catalog from the stored
  facts with no network and no checkout and fails, naming the arrow, when a true arrow is not
  drawn or an arrow nobody wrote down is drawn with no guess flag. Only facts with one-line
  quotes are stored, no source.
- **A size budget.** `pnpm lint` runs `scripts/check-size-budget.mjs`: non-test source may grow by
  at most 3,500 lines over 2.0.0-beta.30, and every run prints the total and the packages that
  grew most. The owner raises the budget by editing one number.
- **Two naysayers on at the design gate.** A new metarepo's application architect's and security
  naysayers give `gates: [design]`, so they run as lenses of the critic there (risks, never
  holding the gate). Delete the line to turn one off. `atticus init` and the `starter-personas`
  upgrade step never write over a naysayer file that is there.

## docs/build-status.md

| Ticket                                                            | State | Where                                                                                           |
| ----------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------- |
| WP-12, a public estate scored offline in CI                       | Built | `fixtures/oss-estate/`, `packages/cli/test/oss-estate-join.test.ts`                             |
| WP-11, a size budget for non-test source                          | Built | `scripts/check-size-budget.mjs` in `pnpm lint`, `packages/conformance/test/size-budget.test.ts` |
| WP-06, the architect and security naysayers on at the design gate | Built | the two starter `*-naysayer.md` files, `packages/cli/test/naysayers-on.test.ts`                 |

## docs/codebase-map.md

- `fixtures/oss-estate/`: two public repos' verified facts at pinned commits, their reference
  arrows (`reference-links.yaml`, the `atticus measure links` format) and licences.
- `scripts/check-size-budget.mjs`: the size budget (`BUDGET`, the per-package `BASELINE` of
  2.0.0-beta.30); `--record` prints a new baseline for the next release.

## Decisions and findings

- **The baseline is recorded in the script, per package**, not read from the tag: CI's checkout
  is shallow with no tags, and counting the working tree alone works the same offline and on
  Windows. Non-test source is every file under `packages/<package>/src/` and root `scripts/` with
  a code extension (`ts`, `tsx`, `mts`, `cts`, `js`, `jsx`, `mjs`, `cjs`, `kt`, `css`), leaving
  out folders named `test`, `tests`, `__tests__` or `fixtures` and `*.test.*`/`*.spec.*` files.
  At 2.0.0-beta.30 that is 456,469 lines.
- **Gate 0 missed one call.** `addVisit` in `src/app/visits/visit.service.ts:65` posts to
  `owners/{ownerId}/pets/{petId}/visits`; the read at gate 0 wrote 30 calls and verify passed
  without it (the file counted as read). The fixture adds the fact, verified against the pinned
  commit, so the estate has 31 calls on 30 Interfaces (GET /owners and the search by last name
  share one). Coverage does not catch a missing call in a file that has other calls.
- **The scorer used is `measureLinks`** (`packages/scanner/src/measure-links.ts`), the link
  scorer. `packages/evals/src/estate-bench.ts` scores flows against reference flows, which this
  estate has none of; the test checks the built catalog's Interfaces against the reference
  directly, entry by entry, which is the stronger check.
- **"Without a flag"** means one of core's `JOIN_GUESS_FLAGS` or `confidence: inferred`. Every
  arrow of this estate carries `joined-by-repo` (the call names its repo), which says how, not
  that it is a guess, so it does not count as a flag.
