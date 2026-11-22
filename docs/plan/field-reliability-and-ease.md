# Plan: stop field issues first, then make Atticus simple

Status: approved (2026-11-18), from a three-part review of 2.0.0-beta.28.5. Built in 2.0.0-beta.30 (2026-11-22) through [the v30 plan](v30.md), except what each item's state names; items 3 (the Windows nightly), 4, 21, 23 and 26 are partly or wholly planned for beta.31 (ADR 0207).
Each numbered item becomes a ticket in `docs/build-status.md` when it is started. Items marked
**ADR** need a new ADR before any code (CLAUDE.md hard rule 1).

## Why

Between beta.28 and beta.28.5 about 55 fixes came from real use (a hand tally of the changelog's
Fixed bullets). The property tests explore catalog _states_ well. Nothing explores estate _shape_,
field _size_ in the app, or real Windows behaviour, and that is where the field issues came from:

| Cause                             | About | Example                                             |
| --------------------------------- | ----- | --------------------------------------------------- |
| Size and long silent steps        | 14    | Discovering 43 clones took 326 s                    |
| Estate shapes the fixtures lack   | 14    | A proxy target written as a deploy token dead-ended |
| States the tests never start from | 10    | A newer `build.json` got "run upgrade" advice       |
| Dead ends in the app              | 9     | One rejected fact blocked the whole write           |
| Stop, closing the app, held files | 5     | Stop ignored after the first repo                   |
| Platform (Windows)                | 5     | A file held by another program                      |

The journeys run on `fixtures/forge/metarepo` (7 tidy repos). `packages/cli/test/field-estate.ts`
(40 repos, 15 gateway proxies, legacy slots, hand pairings) feeds only one speed test.

## Group 1: stop issues reaching the field (2.0.0-beta.28.6, no new features)

1. **The field-shaped estate is the default.** Journeys and the CLI suites run on
   `field-estate.ts`, grown with every shape a field report named (deploy-token hosts, a repo with
   no System, ids with dots, nested payloads, ssh and https origins, a non-gateway callee). Rule:
   a field report adds its shape to the estate, as an invented Forge shape, before its fix, the way
   a property seed adds a file under `properties/regressions`.
   **State:** Built in beta.30 (v30 slice 9): `fixtures/forge-field/`, from `field-estate.ts`.
2. **A shape generator in the property tests.** `properties/estate.ts` varies tokens, dotted ids,
   missing Systems, proxies and nesting. New invariant: every call is drawn, listed loose or asked
   about, and every refusal names a next step.
   **State:** Built in beta.30 (v30 slice 9): the shape properties in `properties/estate.ts`.
3. **Real Windows chaos job.** On `windows-latest`: files really locked by another process, a kill
   mid-write, a slow disk; the property nightly runs there too. Today the held-file logic is
   simulated by `fsHooks.platform = "win32"` on Linux.
   **State:** Partly: the Windows CI jobs run the suites, and CI starts the map tools against `atticus.cmd` there. The property nightly on Windows, with a slow disk and a file really held by another process, is planned for beta.31 (ADR 0207); a kill mid-write is not planned yet.
4. **A plan before a multi-repo action.** `map --all`, `verify --all` and Apply to every repo
   first say which repos they touch, how many builds, a time estimate from the last run's timings,
   files held now, version skew and how far undo reaches. In the app and the CLI.
   **State:** Not in beta.30: planned for beta.31 (ADR 0207).
5. **Release gate.** A release needs items 1 and 3 green. No two releases on one day unless the
   second only reverts.
   **State:** A rule, not code. Not met for beta.30: item 3's Windows nightly is in beta.31.

## Group 2: quick fixes (2.0.0-beta.28.6)

6. **The extension's version check ignores the fourth number** (`packages/vscode/src/app-panel.ts`
   `versionAtLeast`): a 28.1 command line passes as 28.5, so nothing warns and pages fail.
   **State:** Built in beta.30 (v30 step 5).
7. **One install command everywhere**, with the exact version, from one constant (today `@latest`
   in the extension, `@beta` in two places, none in a third).
   **State:** Built in beta.30 (v30 step 5).
8. **Live progress on one repo's Apply** in the app: the step now, time so far, Stop, and a Done
   line that stays.
   **State:** Built in beta.30 (v30 slice 2).
9. **One forward button on every refusal.** Dead ends today: newer Atticus (a command only),
   rejected facts (no link to them), unexplained removals (no button), empty catalog and nothing
   read (no next step), a catalog from before beta.27 (the button is on another page).
   **State:** Built in beta.30 (v30 slice 2, ADR 0202).
10. **Recovery on every error screen:** Undo the last build, Build again, Save a support bundle.
    **State:** Built in beta.30 (v30 slice 2, ADR 0202).
11. **Doctor on corporate Windows:** PowerShell execution policy, the npm prefix on PATH; sync
    turns git's auth, 407 and TLS errors into what to do.
    **State:** Built in beta.30 (v30 step 5).

## Group 3: simple to use (after 28.6; each its own design)

12. **Connect A to B on every box (ADR).** One action; Atticus pairs calls when it can, and
    otherwise offers an arrow marked as declared by a person. Today a repo box offers only pairing,
    an outside-system box only Declare, and Declare to a repo that is no gateway ends at "isn't
    supported yet". Changes the profile contract (C6) or the catalog's arrows (C1).
    **State:** Built in beta.30 (ADR 0204, profile version 3).
13. **Write and Apply as one action** for a connection: preview, write, apply, show the arrow.
    **State:** Built in beta.30 (ADR 0204).
14. **Add, sync, read and apply new repos in one action**, with progress on the page.
    **State:** Built in beta.30 (ADR 0204 decision 4: Sync, read and apply these N).
15. **`atticus status`**: "you are on X, this metarepo is at Y, the extension needs Z: do this",
    shown after every refusal and on Home. Upgrade asks once in a terminal instead of a re-typed
    `--yes --accept-changes N`.
    **State:** Built in beta.30 (ADR 0202 points 7 to 10).
16. **Plain words, one name each** in the copy file ("loose call", "curated", "slot", three
    meanings of "Apply"); messages lead with what to do.
    **State:** Built in beta.30 (v30 slice 8; the glossary `docs/guide/words.md`).
17. **Fewer pages.** 59 today, 29 default tabs. Map keeps Map, Flows and one read-status tab.
    **State:** Built in beta.30 (v30 slice 8): 54 pages and 23 default tabs.

## Group 4: finding a field issue without anything leaving the site (design note first)

An employer's or client's data stays where it is. Whether anything at all may leave, a count
included, is that organisation's decision, never Atticus's or its author's. So the design is in
this order, and each step is useful without the next:

18. **`atticus selfcheck`, run on site.** It runs the invariants the tests hold (every call drawn,
    loose or asked; every refusal has a next step; a build twice gives the same bytes; no step
    silent for more than 30 s) against the real metarepo, read-only, on that machine. It writes
    nothing outside the metarepo's `.atticus` folder and sends nothing. Its answer is a list of
    named checks that passed or failed. A failed check names the invented regression shape closest
    to it, so the fix can start from the Forge estate.
    **State:** Built in beta.30 (ADR 0202: `atticus selfcheck`).
19. **A shape card, read on screen.** One screen of answers from a fixed list of words, with no
    name, id, path, hash or free text from the estate: repos in a size band (20 to 50), records in
    a band, which shape flags are present (gateway proxies, deploy-token hosts, repos with no
    System, dotted ids), the platform, and the slowest step in a time band. No hashes: a hash of a
    guessable name can be reversed. It is not written to a file by default.
    **State:** Built in beta.30 (ADR 0202: the shape card).
20. **Dials on the invented estate.** `field-estate.ts` takes the same fixed words as its options,
    so an estate of the same shape and size is made from Forge names on any machine. The card's
    words can be set from memory; nothing has to be carried.
    **State:** Built in beta.30 (`field-estate.ts` takes the card's words as `shape` and `ATTICUS_FIELD_SHAPE`).

Out of scope, and not to be built: any upload, telemetry, or bundle that holds a name, id, path,
hash, record, fact, code line or log line from a real estate. `atticus support bundle` (ADR 0050)
stays as it is: local, read by a person before it goes anywhere, and only where its owner's rules
allow that.

## Group 5: the change flow as flexible as personas with OpenSpec (design notes first)

Found by walking three kinds of change through the stages by reading the code (nothing was run):
a new portal no repo holds yet, a move of existing services to another platform, and a new event
to an existing hub. Other teams reach an OpenSpec change from a free-form requirements file and a
few personas with their naysayers; Atticus's stages block where its map or its change model has no
word for the work. The map is the advantage (cited impact, consumers, owners, conflicts, the
built code checked against the design); the stages are the cost.

| Kind of change               | Today               | First blocker                                                 |
| ---------------------------- | ------------------- | ------------------------------------------------------------- |
| New portal, new repos        | Works with friction | `feature.unknown-repo` has no planned-repo exemption          |
| Move services to a platform  | Blocked             | No step change gives `delta.empty`, then no stories           |
| New event to an existing hub | Works with friction | `delta.unknown-consumer` for a consumer in a repo nobody read |

21. **The map your personas ask.** `atticus mcp` already serves about 35 read-only tools (ask,
    impact, search, walk, similar). Ship it as an entry point of its own with a persona
    instruction, and add `owners`, `consumers_of`, `conflicts` and `similar_changes`. No stage.
    (Additive C4: small ADR for the new tools.)
    **State:** Partly: the personas' entry point and `conflicts` are built (ADR 0201); `owners`, `consumers_of` and `similar_changes` are planned for beta.31 (ADR 0207).
22. **`atticus review <requirements.md>` (ADR).** The deterministic checks that apply and the
    critic's questions, run over a free-form file with the map as evidence. Every finding is a
    question with its cited line; nothing blocks. Answers are written back into the file.
    **State:** Built in beta.30 (`atticus review`, ADR 0201 and ADR 0203 part C).
23. **Two speeds per change (ADR, C6).** Quick: requirements, questions, then a plain OpenSpec
    change (proposal, specs, design, tasks) any team can pick up. Full: the stages, task runs and
    conformance, for the changes that carry the risk. A change can move from quick to full.
    **State:** Partly: the quick path is built (ADR 0201, ADR 0206); moving a change from quick to full is planned for beta.31 (ADR 0207).
24. **Accept with a reason (ADR, C3).** A blocking stage finding (`feature.*`, `delta.*`,
    `stories.*`) can be accepted by a named person with a reason, as critic findings can today.
    Constitution rules stay as they are (hard rule 6).
    **State:** Built in beta.30 (ADR 0203 part A).
25. **Work that is no runtime step (ADR, C1 and C6).** A work item for deployment, pipeline,
    config, secret and route, so a migration has stories and tasks with no step change; a change
    fanned out over N repos with waves, cut-over and rollback.
    **State:** Built in beta.30 (ADR 0203 part B; checked against the code by ADR 0206).
26. **Planned and outside parties (ADR).** A planned repo passes the feature stage; a new folder
    in an empty repo is a note; a consumer in a repo nobody read can be declared; a planned topic
    carries its schema and settings.
    **State:** Partly: a planned repo, a new folder in an empty repo and an outside party are built (ADR 0201, ADR 0203 part B); a planned topic's schema and settings are planned for beta.31 (ADR 0207).

In beta.30 all three kinds work: on the quick path (`atticus change new --from requirements.md`,
the personas asking the map), or, for a migration or a product in new repos, through the stages
with operations.
