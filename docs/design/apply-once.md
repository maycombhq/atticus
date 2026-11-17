# One catalog build for an Apply over several repos

- Status: a design note, not built. Written 2026-11-16 with the change that made the map's bar apply only the repos that wait (ADR 0198).
- Question: an Apply over N repos runs `verify <repo> --write` N times, and each one builds the whole catalog. Can the run check every repo's facts first and build once?
- Answer: yes for the catalog, and it would be faster by about a factor of N. It was not built with ADR 0198 because it cannot be made to leave "the same bytes N applies leave". The reason is that N applies do not leave one well-defined result. The sections below say what was measured, what blocks it and how to build it.

## What was asked for

Build once only if the result is byte for byte the catalog and maps that N applies one after another leave, with each repo's outcome still reported truthfully: applied, applied with facts left out (exit 3, beta.28.1), not applied, build refused.

## What was measured

`packages/cli/test/apply-order.test.ts` takes a generated Forge estate of five repos, changes three of them and applies the three twice on two copies: once in id order, as the app's run does, and once in the reverse order.

| What the two orders leave                               | Same bytes?                       |
| ------------------------------------------------------- | --------------------------------- |
| `catalog/generated`, `catalog/sources` and `build.json` | Yes, all of it                    |
| `facts/<repo>.verify.yaml`                              | No, for all three repos           |
| `map/<repo>/map.md`                                     | No, for one repo                  |
| `questions/q-*.yaml`                                    | No, for two (who asked, and when) |
| Everything else (specs, flows, facts, org pack)         | Yes                               |

The map that differs shows why. `forge-svc-02` calls an API of `forge-svc-01`, and the change to `forge-svc-01` takes that API away. Applied before `forge-svc-01`, the map of `forge-svc-02` draws the call as reaching that API and its report says 12 calls joined. Applied after, the map has no such link and the report says 11 joined and 1 missed. The catalog is the same in both. Only the second map agrees with it.

So each repo's map, report and questions describe the estate as it stood when that repo was applied. A repo applied early keeps a picture that a later repo's Apply made out of date. This is how the run behaves today, in any order.

## What this means for building once

**The catalog.** A build is a function of the slots and the build's inputs. `packages/cli/test/big-estate-equivalence.test.ts` already holds that after each `verify <repo> --write` the catalog is the bytes a build from scratch of the same slots and inputs makes. N applies end with N slots updated, and one build over those N slots is that same build from scratch. For the catalog, build-once equals N applies when two conditions hold: no build in the sequence is refused, and no input changes between the builds. The order test confirms the first half of this from the other side.

**The maps and reports.** Build-once would render every repo's map and write every repo's report from the final catalog. That equals what N applies leave only for the last repo applied. For the others it is more correct than today, and for that reason not the same bytes. The requirement as written cannot be met, and should not be: the right target is "what each repo's Apply would leave if it were run last", which is also what `atticus map render <repo>` gives afterwards.

## What blocks a provably equivalent version

1. **The per-repo files are tied to the build they came from.** `writeFactsIntoCatalog` (`packages/cli/src/map-render-commands.ts`) takes one repo's flows, loose calls, join and target questions from the build (`build.facts.get(repo)`), and its link changes from a diff against the catalog as it was before that build (`linkChanges(repo, join, existing, records)`). One build can serve every repo's `build.facts` entry. The diff cannot be split: with one build, "the links this repo's Apply added and removed" becomes "the links this run added and removed that touch this repo". That is a change to the content of `facts/<repo>.verify.yaml`, which is committed and proposed for review.

2. **The removal guard counts per build.** `REMOVAL_LIMITS` (`packages/scanner/src/build.ts`) refuses a build that removes more than 10% of a repo's records or more than 200 records in one build. The two ways of running differ in both directions:
   - Four repos that each remove 60 records pass one at a time and are refused together (240 is over 200).
   - A link that the first repo's Apply removes and the second repo's Apply puts back is a removal for the first build and no removal for the combined one. The first build can be refused where the combined build passes.

   After a refusal, N applies leave that repo's slot as it was and go on to the next repo. One build has one verdict for all N. No rule gives the same slots in every case.

3. **A refusal is confirmed per repo.** The confirm is tied to the command that was refused: `POST /api/facts/{repo}/apply` checks that the last build's report is `atticus verify <repo> --write` with the plan the page showed (`refusalStillListed` in `packages/cli/src/ui-api.ts`). A combined build's refusal lists removals across repos under one command. It needs its own confirm route and screen, or a rule that sends the person to Set up › Scans › Catalog builds. That is a C4 change and needs its own ADR.

4. **Questions are build inputs, and Apply writes them after it builds.** After its build, a repo's Apply raises, refreshes, retires and reopens questions. A reopened answer (`reopenQuestion`: the code read since disagrees with it) changes what the next repo's build joins. With one build, every reopening comes after the build. The catalogs then differ whenever a repo that is not last reopens an answer. This is rare, but it is a real difference, and build-once would need a second build when it happens.

5. **Facts left out (exit 3).** `leftOutOf` works per repo from the verifier's report and the repo's last accepted facts. It does not depend on the build, so it carries over unchanged. Each repo's count, and the lines naming each fact, stay truthful.

6. **Rejected facts and refusals before the build.** A repo whose facts are rejected outright, whose read is at another commit, or which has no clone, never reaches the build today. With build-once it is left out of the set of slot writes and reported as now. This also carries over.

7. **The newer-Atticus refusal** (ADR 0197) is checked before anything is read and applies to the whole catalog. One check at the start of the run is equivalent.

## Undo

Today each repo's Apply takes its own undo copy, and five are kept (`UNDO_KEEP`). A run over six or more repos pushes out its own first copies, so after a long run the catalog cannot be taken back to where the run started. A person can only step back through the last five repos.

Build-once should take **one undo copy for the run**. One undo then takes back the whole run, which is what a person who clicked one button expects. Whether the undo copy also covers each repo's files outside the catalog (specs, flows, contract companions) was not checked for this note and must be, with a test.

## Locks

Each repo's Apply takes and releases the scan's lock, so another writer (a terminal's scan) can get in between two repos. Build-once must hold the lock from the first slot write to the last map, or it must check again after the build that no slot changed under it. Holding it is simpler. The lock would be held for about one build, which is shorter than today's whole run.

## Stop

A job's Stop is heard until its work says it is writing (`commitCurrent`, beta.28.1). After that it is too late, and the job says so. Until ADR 0198 the first repo's write set that state for the whole job and nothing cleared it, so Stop was not heard between repos after the first write.

This is fixed with today's run (ADR 0198, point 6). The run says when a repo's write has ended (`releaseCurrent`), a Stop asked during that write is acted on then, and `verifyAllCommand` ends before the next repo, saying which repos are not applied. `packages/cli/test/apply-all-stop.test.ts` holds it over a three-repo run, and holds that one repo's own Apply is still never cut short.

With build-once, Stop would be heard through every repo's check and through the build, up to the one write. The release is then not needed for this run, but it stays correct.

## The approach

1. **Check.** For each repo in id order, run the verifier as `verify <repo>` does, without the write. Repos that fail outright are reported and set aside. Repos with rejected facts go on with those facts left out, as now (exit 3).
2. **Build once.** Take the lock. Make every remaining repo's facts snapshot (`factsSnapshotWrites`), put them all in place of the slots on disk, and build. `buildAndWrite` already takes several slot writes and a build made by the caller, which is how a scan uses it.
3. **Guard once.** If the build is refused for removals, fall back to today's run for this set of repos, one after another. Each repo then gets its own verdict and its own confirm, exactly as now. Refusals are rare, and the fallback costs one wasted build.
4. **Write once,** with one undo copy.
5. **Per repo, from the final build:** contracts, specs, flows, the report, the questions and the map. The link changes in each report are the run's changes that touch the repo, and the report says so.
6. **Build again only if a question was reopened** in step 5, and say so.

Cost: one build and N renders where today's run costs N builds and N renders. Where one build takes ten minutes and seven repos wait, that is about ten minutes in place of seventy. This is an estimate from the design, not a measurement.

## What has to be decided first

- That a repo's report lists the run's link changes that touch it, and no longer its own Apply's alone. This changes what `facts/<repo>.verify.yaml` means in a run. No schema changes.
- That every map of the run is rendered from the final catalog. This fixes the out-of-date maps shown above.
- One undo copy per run.
- The fallback on a refused build, in place of a combined confirm.

These are changes to behaviour a person sees, so they need an ADR. They do not change C1 to C6 if the fallback is taken.

## The tests it needs

- **Catalog equivalence.** Over generated Forge estates, with corrections or code changes in several repos: the catalog, slots and `build.json` after build-once are the bytes N applies leave. Include a repo whose facts are all rejected (set aside), a repo with facts left out (exit 3), and a repo with no clone.
- **Maps and reports.** Each repo's map after build-once is the bytes `atticus map render <repo>` writes from the final catalog. Each report's counts agree with the final catalog. The order test's stale map must no longer occur.
- **Refusal.** A set where one repo's removals are over the limit: the fallback runs, that repo is refused with its own listing and plan, the others are applied, and the result's `applied` and `notApplied` say so. A set that passes one at a time and is over 200 together: the fallback runs and every repo is applied.
- **Reopened answer.** A repo whose facts disagree with an answer another repo's call rests on: the second build runs, and the catalog is the one N applies leave.
- **Undo.** One undo after the run puts back every file the run wrote, in every repo.
- **Lock.** A writer that asks for the lock during the run is refused until the run ends.
- **Stop.** Asked during the checks or the build: nothing is written, and the job ends stopped. Asked during the write: the write finishes, and the job says so.
- **Outcome codes.** `onRepo` gets the same code for each repo that N applies give, for every case above.
