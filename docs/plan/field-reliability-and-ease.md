# Plan: stop field issues first, then make Atticus simple

Status: proposed (2026-11-18), from a three-part review of 2.0.0-beta.28.5. Nothing here is built.
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
2. **A shape generator in the property tests.** `properties/estate.ts` varies tokens, dotted ids,
   missing Systems, proxies and nesting. New invariant: every call is drawn, listed loose or asked
   about, and every refusal names a next step.
3. **Real Windows chaos job.** On `windows-latest`: files really locked by another process, a kill
   mid-write, a slow disk; the property nightly runs there too. Today the held-file logic is
   simulated by `fsHooks.platform = "win32"` on Linux.
4. **A plan before a multi-repo action.** `map --all`, `verify --all` and Apply to every repo
   first say which repos they touch, how many builds, a time estimate from the last run's timings,
   files held now, version skew and how far undo reaches. In the app and the CLI.
5. **Release gate.** A release needs items 1 and 3 green. No two releases on one day unless the
   second only reverts.

## Group 2: quick fixes (2.0.0-beta.28.6)

6. **The extension's version check ignores the fourth number** (`packages/vscode/src/app-panel.ts`
   `versionAtLeast`): a 28.1 command line passes as 28.5, so nothing warns and pages fail.
7. **One install command everywhere**, with the exact version, from one constant (today `@latest`
   in the extension, `@beta` in two places, none in a third).
8. **Live progress on one repo's Apply** in the app: the step now, time so far, Stop, and a Done
   line that stays.
9. **One forward button on every refusal.** Dead ends today: newer Atticus (a command only),
   rejected facts (no link to them), unexplained removals (no button), empty catalog and nothing
   read (no next step), a catalog from before beta.27 (the button is on another page).
10. **Recovery on every error screen:** Undo the last build, Build again, Save a support bundle.
11. **Doctor on corporate Windows:** PowerShell execution policy, the npm prefix on PATH; sync
    turns git's auth, 407 and TLS errors into what to do.

## Group 3: simple to use (after 28.6; each its own design)

12. **Connect A to B on every box (ADR).** One action; Atticus pairs calls when it can, and
    otherwise offers an arrow marked as declared by a person. Today a repo box offers only pairing,
    an outside-system box only Declare, and Declare to a repo that is no gateway ends at "isn't
    supported yet". Changes the profile contract (C6) or the catalog's arrows (C1).
13. **Write and Apply as one action** for a connection: preview, write, apply, show the arrow.
14. **Add, sync, read and apply new repos in one action**, with progress on the page.
15. **`atticus status`**: "you are on X, this metarepo is at Y, the extension needs Z: do this",
    shown after every refusal and on Home. Upgrade asks once in a terminal instead of a re-typed
    `--yes --accept-changes N`.
16. **Plain words, one name each** in the copy file ("loose call", "curated", "slot", three
    meanings of "Apply"); messages lead with what to do.
17. **Fewer pages.** 59 today, 29 default tabs. Map keeps Map, Flows and one read-status tab.

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
19. **A shape card, read on screen.** One screen of answers from a fixed list of words, with no
    name, id, path, hash or free text from the estate: repos in a size band (20 to 50), records in
    a band, which shape flags are present (gateway proxies, deploy-token hosts, repos with no
    System, dotted ids), the platform, and the slowest step in a time band. No hashes: a hash of a
    guessable name can be reversed. It is not written to a file by default.
20. **Dials on the invented estate.** `field-estate.ts` takes the same fixed words as its options,
    so an estate of the same shape and size is made from Forge names on any machine. The card's
    words can be set from memory; nothing has to be carried.

Out of scope, and not to be built: any upload, telemetry, or bundle that holds a name, id, path,
hash, record, fact, code line or log line from a real estate. `atticus support bundle` (ADR 0050)
stays as it is: local, read by a person before it goes anywhere, and only where its owner's rules
allow that.
