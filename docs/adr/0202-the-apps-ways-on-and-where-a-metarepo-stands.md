# 0202. The app can do what the command line can when something goes wrong, and Atticus says where a metarepo stands

- Status: accepted (2026-11-18, by the owner, with the recommended answers: the build.json field is read and not written in beta.30; the status line follows every refusal; one prompt also covers --discard-edits (an unreadable build.json keeps the typed count))
- Date: 2026-11-18
- Release: 2.0.0-beta.30, slices 2 and 7 of [the plan](../plan/v30.md); Group 4 of [the field plan](../plan/field-reliability-and-ease.md)
- Extends: ADR 0050 (the support bundle), ADR 0187 (jobs and the Console), ADR 0195 (the build's guards, undo), ADR 0197 (`build.json`, the newer-Atticus refusal)
- Contracts: C4, additive only: the local API becomes 3.19.0 (3.17.0 today; 3.18.0 is ADR 0201's `quickPath`), and the command line gains `atticus status`, `atticus selfcheck` and one prompt. `build.json` stays version 2 and no byte of it changes (point 7). C1, C2, C3, C5, C6 and the facts file are unchanged. No migration.

## Context

Slice 2 gave the app a way on from every refusal and error, using only what the local API had. Its review listed seven things the screens could not do without a change to the API: they show a command to copy where the command line just does the thing. Slice 7 is the other half of the same trouble: when Atticus refuses, a person has to work out which of three versions is behind (their Atticus, the metarepo, the catalog) before they know what to type. Group 4 asks how a field issue is found when nothing may leave the site.

## How it is today

Read in the code on `release/b30`; nothing was run.

- **Support bundle.** `atticus support bundle` builds its files in `bundleFiles` and writes the zip under `.atticus/logs/` (`packages/cli/src/support.ts:67`, `:143`). No route runs it; the app shows the command to copy (`packages/ui/src/app/ways-on.tsx:83`). The server answers in JSON only (`packages/server/src/server.ts:246`).
- **Stop.** The job manager knows when a job is past its write (`committedIds`, `packages/server/src/jobs.ts:168`, `:486`) and says "Stop came after the write had started…" (`:116`). The API's `Job` has `stopping` and nothing that says a Stop is too late (`packages/core/src/api.ts:1093`). Propose and Bring in run as local jobs (`packages/cli/src/ui-api.ts:1014`, `:1036`); `proposeForReview` takes no signal and prints one line, after the push (`packages/cli/src/propose.ts:315`, `:370`).
- **Undo.** `GET /api/build/undo?n=1` gives the plan and `POST /api/build/undo` takes `n`, `files` and the plan's hash (`packages/cli/src/ui-api-catalog.ts:304`, `:312`). An error screen links to the Undo panel on another page (`ways-on.tsx:142`) and doesn't know which build an undo would take back. After a refusal nothing was written, so the "last build" is an earlier, good one.
- **Trust.** `GET /api/trust` returns every repo, each with `lists.rejected` (`api.ts:1669`); the page takes `?repo=` as filter words (`packages/ui/src/screens/map/Trust.tsx:870`).
- **A job after a reload.** The page keeps the job's id in memory. A job has a `title` in words ("Applying to forge-ledger", `ui-api.ts:900`) and nothing a page can look it up by; there is no route that lists jobs.
- **The task board.** `planReadyTasks` gives each task `why` (`packages/taskrun/src/ready.ts:157`) and the plan `notes` (`:204`). The board copies only `waitsFor` (`ui-api.ts:516`), so a task held by `(after t9)` that names no task, or by a cycle, shows as waiting for nothing. `GET /api/changes/{id}/tasks` returns a bare array (`api.ts:8421`), so it has no place for the plan's notes.
- **The newer-Atticus hint.** Its command is the constant `npm i -g @maycombhq/atticus@beta` because "the catalog's files say their format's version, not the Atticus that wrote them" (`packages/scanner/src/slots.ts:640` to `:644`). The check reads a file's first 512 bytes (`:576`, `packages/scanner/src/build.ts:2325`). **`BuildManifest` is a strict object** (`slots.ts:159`): beta.28.2 to beta.28.5 read a version 2 file with one more key as unreadable, and refuse with `hand-edits` and "build again with --discard-edits", which is the wrong advice.
- **Where a metarepo stands.** `upgradeCheck` gives this Atticus, the stamp, `newer` and the pending steps (`packages/cli/src/upgrade.ts:587`, `:656`); doctor's "Metarepo version" check words it (`packages/cli/src/doctor.ts:676`); `GET /api/upgrade` serves it (`ui-api.ts:946`). The version the extension needs is a constant in the extension (`packages/vscode/src/app-panel.ts:65`); the command line never hears it.
- **Confirming.** A refused build prints "Confirm exactly these: … --allow-removals N" or "--discard-edits N" (`build.ts:2578`, `:2895`), and upgrade prints "Accept exactly these with: atticus upgrade --yes --accept-changes N" (`upgrade.ts:806`). The person types the command again with the count.
- **The run log** keeps a command's lines with no time on them (`packages/core/src/run-log.ts:922`), so a silent step can't be found in it afterwards.

## Decision

Every word below goes in the copy file (`packages/ui/src/copy.ts`) or, for the command line, in one constant beside its command.

### A. What the app's review asked for

**1. Save a support bundle.** `POST /api/support/bundle`, no body. It runs `supportBundleCommand`'s own steps and writes the same file in the same place. It answers 200 with `SupportBundleView`: `{ file, name, bytes, files: string[], zip? }`. `file` is the path from the metarepo's root, `files` the names in the zip, `zip` its bytes in base64, left out above 8 MB. It is not a job, makes no network call and has no parameter that names a destination. The app's button is "Save a support bundle". After it: "Saved <file> (<n> files). Nothing was sent anywhere. Read every file before you send it outside your organisation." with "Save a copy…" (from `zip`, when the browser can) and "Copy the path". The command stays below it for a terminal.

**2. A job says whether Stop can still take effect.** `Job` and `ActivityEntry` gain:

| Field       | Value                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stoppable` | `true` while the job runs, is not stopping, and a Stop would end it: before its write, or during a write of a job of several (ADR 0198). `false` otherwise. Always present on a job. |
| `stopLands` | only when `stoppable`: `now`, or `after-write` (the job of several is inside a write; it ends when that write has finished)                                                          |

The panel shows Stop only when `stoppable`, labelled "Stop" or, for `after-write`, "Stop after this repo". When it turns false while the job runs the panel says "Too late to stop: the write has started and finishes whole." `POST /api/jobs/{id}/cancel` is unchanged.

Propose and Bring in say their step. Each prints a progress line before the step starts, which the job carries as its message:

| Job      | Lines, in order                                                                                                                        | Its commit point                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Propose  | "Listing what changed…", "Committing <n> files to <branch>…", "Pushing <branch>…", "Opening the pull request…"                         | just before the push                    |
| Bring in | "Fetching <upstream>…", "Bringing in <n> commits…" (or the "Nothing new has merged" line it has today), "Putting your own edits back…" | just before the working tree is changed |

Both take the job's signal and check it between steps. A Stop heard before the commit point ends the job `cancelled` with: "Stopped before the push: nothing left this machine. The commit is on <branch> here; Propose again pushes it." (Propose) or "Stopped before anything was brought in: your copy is as it was." (Bring in). After it, `stoppable` is false.

**3. Undo the last build in one click from an error.** A local job that ends failed or refused, and a 409 problem from a build route, carry `undo` when a build can be taken back:

```json
{
  "undo": {
    "n": 1,
    "files": 12,
    "plan": "<64 hex>",
    "command": "atticus verify forge-ledger --write",
    "at": "<time>",
    "ofThis": false
  }
}
```

`n`, `files` and `plan` are `GET /api/build/undo?n=1`'s; `command` and `at` are that undo copy's. `ofThis` is true only when the undo copy was taken by the job that failed. With no build to undo the field is left out and no button is shown. The button reads "Undo this build" when `ofThis`, else "Undo the last build (<command>, <time>)". One click opens the confirm undo has today, in place: the files it puts back, "Take back this build?", and Undo, which sends `POST /api/build/undo` with the three values. A list that changed meanwhile is refused as today. Nothing is undone without the confirm.

**4. Rejected facts only, for one repo.** `GET /api/trust?repo=<id>&rejected=1` returns `TrustView` with only that repo's row, and in it `lists` holding only `rejected`, every line (no cap). An id that is no repo is 404; `rejected=1` without `repo` is 400. Without parameters the route is as today. The page's address is `#/trust?repo=<id>&rejected=1`: the repo's row opened at its rejected facts, under the heading "<n> rejected facts in <repo>", each with its place, code, reason and Drop. The refusal's button "See the <n> rejected facts on Map › Trust" goes there. Empty: "No fact of <repo> is rejected now."

**5. A running job found again.** A job started by a page's action carries `for`: `{ action, repo? }`, with `action` one of `apply`, `apply-all`, `build`, `undo`, `upgrade`, `propose`, `bring-in`, `sync`, `scan`. `GET /api/jobs?action=<a>&repo=<id>` returns `{ jobs: Job[] }`, newest first: the running job that matches, then the finished ones this server still keeps (100 in all, lost when `atticus ui` stops). With no parameter it lists every job kept. On load a panel asks for its own action. A running job is shown again with its message, the time since `startedAt`, Stop by point 2 and its lines from `GET /api/activity/{id}/lines`. With none running, the newest finished one within the last ten minutes shows its Done, Refused or Failed line and its ways on. After a restart of the server the panel says nothing, as today.

**6. Why a task isn't ready.** `Task` gains `why`: the ready plan's sentence for a task that is not done and not ready, whatever holds it ("it names task t9 in (after …), which tasks.md doesn't have"). It gains `note`: the plan's note about that task, when there is one. The card shows `waits` as today, and `why` when `waits` is absent: "Not ready: <why>." `note` is shown as a note on the card.

**7. The newer-Atticus hint names the exact version.** The aim was one more key in `build.json` version 2 with no bump. The code rules that out: the version 2 reader is strict, so beta.28.2 to beta.28.5 would take a beta.30 catalog for a hand-edited one. So:

- **The field** is `atticus`, a string, the second key of `build.json`, after `version`, so it is in the first 512 bytes. Its value is the version of the Atticus that last wrote a change to the catalog. A build that changes no file and no source keeps the value it found, so building twice still gives the same bytes.
- **Beta.30 reads it and does not write it.** `BUILD_MANIFEST_VERSION` stays 2 and the version 2 schema stays strict. Where a file is newer than this Atticus reads, the head read also takes `atticus`. It is used only when it matches `^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$` and is newer than this Atticus; anything else is ignored, because the value goes into a command a person copies.
- **The first release that raises `BUILD_MANIFEST_VERSION` writes it**, in that version's schema. That release's ADR repeats this rule.
- **The refusal.** `newer[]` gains `atticus` on the `build.json` entry. `command` is `npm install -g @maycombhq/atticus@<that version>` when known, else `npm i -g @maycombhq/atticus@beta` as today. The words become "…built by Atticus <v> (build.json version N; this Atticus reads up to M): install it (<command>), don't run `atticus upgrade`." The app's "Copy the install command" copies the refusal's `command`.

### B. Slice 7

**8. `atticus status [--json]`, and the same on Home.** One function, `standing(root)`, in `packages/cli/src/standing.ts`, built on `upgradeCheck`, `newerAtticusOf`, `newerCatalogOf` and doctor's `isMetarepo`. It returns the parts and one line made of them:

- "You are on Atticus <X>."
- "This metarepo is at <Y> (.atticus/metarepo.yaml)", or "This metarepo has no stamp yet", or "This metarepo's stamp is one this Atticus can't read"
- ", and its catalog was built by Atticus <Z>." (point 7's field, when there), or ", and this Atticus reads its catalog.", or ", and its catalog was built by a newer Atticus.", or ", and it has no catalog yet."
- "The extension needs <W>." Only when the extension said so: it sets `ATTICUS_EXTENSION_NEEDS` for the `atticus ui` it starts and for its terminals.
- "Do: <one command>" or "Nothing to do."

The first case that holds decides `state` and the command:

| `state`           | When                                                                        | Do                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `no-metarepo`     | the folder is not a metarepo                                                | `atticus init <folder>`, or `cd metarepo` in a sandbox; the line is "You are on Atticus <X>. This folder isn't an Atticus metarepo. Do: …" |
| `catalog-newer`   | `newerCatalogOf` finds a file                                               | the install command of point 7                                                                                                             |
| `atticus-behind`  | the stamp is newer than X or can't be read, or W is newer than X            | `npm install -g @maycombhq/atticus@<the newer of Y and W>`; `@beta` when neither is known                                                  |
| `metarepo-behind` | there is no stamp, the stamp is older than X, or an upgrade step is pending | `atticus upgrade`                                                                                                                          |
| `up-to-date`      | none of these                                                               | "Nothing to do."                                                                                                                           |

`atticus status` prints the line, then "<n> upgrade steps wait." when any do. It exits 0 for `up-to-date` and 1 otherwise. `--json` and `GET /api/status` give `StandingView`: `{ atticus, state, stamp?, stampUnread?, catalog: "none" | "read" | "newer", catalogBuiltBy?, extensionNeeds?, pendingSteps, do?, line }`. Home shows the line at its top with one button: "Upgrade the metarepo" (the upgrade panel) for `metarepo-behind`, "Copy the command" for the two install cases, none when up to date.

**Every refusal ends with the same line.** A command that refuses a build, an upgrade or a write for one of the reasons of `BuildRefusalView`, or because the metarepo was upgraded by a newer Atticus, prints the line last, on standard error, and carries it as `standing` in `--json` and in the 409 problem. There it is worked out without the upgrade steps' dry runs, which read every record: a step counts as pending when the stamp doesn't name its id. The app shows it under the refusal's button.

**9. Upgrade asks once.** `Output` gains `ask`, set only when standard input and output are both a terminal, `--json` is not given and `CI` is not set. Where it is set and the count flags were not given:

| Command                                          | After the list it prints today, it asks                                      | Yes does                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------ |
| `atticus upgrade`, the slots step with N changes | "Accept these N? [y/N]"                                                      | `--yes --accept-changes N`                 |
| `atticus upgrade`, the slots step with no change | "Apply this step? It changes no record file. [y/N]"                          | `--yes`                                    |
| a build refused with `large-removals`            | "Remove these N records? [y/N]"                                              | the same command with `--allow-removals N` |
| a build refused with `hand-edits`                | "Discard these N hand edits? A copy is kept for atticus catalog undo. [y/N]" | the same command with `--discard-edits N`  |
| both                                             | "Discard these N hand edits and remove these M records? [y/N]"               | both flags                                 |

One question a command, asked once. Only `y` or `yes`, in any case, is yes; Enter, anything else and end of input are no, which prints "Nothing written." and ends as the refusal ends today. Yes runs the step with the count and the refusal's `plan`, so a list that changed between the listing and the answer writes nothing, as the app's confirm does. It is never asked for `unexplained-removals`, `newer-atticus`, `not-upgraded`, `nothing-read`, `empty` or a `build.json` that doesn't read; those keep their one command. `--yes --accept-changes N`, `--allow-removals N` and `--discard-edits N` stay as they are for scripts, and without a terminal the printed lines are byte for byte today's. The guard itself (`packages/scanner/src/build.ts`) asks nothing: the prompt is one helper in the command line, `confirmOnce`.

**10. `atticus selfcheck [--names] [--json]`.** It runs on the person's machine against the real metarepo, read-only. It makes no network call and no model call. It takes the scan lock and writes the usual one line to `.atticus/logs/atticus.log`; it writes nothing else, anywhere.

| Check                     | Passes when                                                                                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calls-accounted`         | every call in the catalog is drawn as a link, listed as a loose call or asked about in an open question (the tally `atticus doctor --counts` makes; the remainder is 0)                                   |
| `refusals-have-next-step` | the build's guard, run as `catalog build --check` does, and `standing` either don't refuse or name at least one command                                                                                   |
| `build-is-repeatable`     | two builds in memory from the sources on disk, the second with no kept parse or build cache read, give `build.json` texts that are equal byte for byte. It lists every file's hash, so no file is written |
| `no-long-silence`         | the newest finished run of each long command on record has `longestQuietMs` of 30,000 or less                                                                                                             |

For the last check the run record (`.atticus/logs/running/<runId>.json`, ADR 0187) gains `longestQuietMs`: the longest time between two lines the command printed, progress lines included. A run from before beta.30 has none, and the check is then `skipped`: "No run on record since this Atticus was installed: run the command once, then selfcheck again."

It prints "atticus selfcheck: <p> of <n> checks passed. Nothing was sent anywhere.", then a line a check: `passed`, `failed` or `skipped`, its id and one sentence with counts only. Under a failed check: "Closest invented shape: <flag>. Make it: ATTICUS_FIELD_SHAPE=<the card's words>". The flag is the first of that check's listed flags that the card finds present, else "none known: this is a new shape". `--names` adds, on screen only, the first 20 ids or paths behind each failed check, for the person on site. Exit 0 when none failed, 1 when one did, 2 for a folder that is no metarepo.

**The shape card** is printed after the checks: one screen, every word from this list, in `packages/cli/src/shape-words.ts`.

| Line         | Words                                                                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| repos        | `1-5`, `6-20`, `21-50`, `51-100`, `over-100`                                                                                                                                                                                |
| records      | `under-1k`, `1k-10k`, `10k-50k`, `50k-200k`, `over-200k`                                                                                                                                                                    |
| flags        | any of `gateway-proxies`, `deploy-token-hosts`, `repos-with-no-system`, `dotted-ids`, `nested-payloads`, `ssh-origins`, `https-origins`, `non-gateway-callee`, `legacy-slots`, `hand-pairings`, `empty-repo`, `unread-repo` |
| platform     | `windows`, `macos`, `linux`                                                                                                                                                                                                 |
| slowest step | one of `sync`, `read`, `verify`, `build`, `scan`, `other`, `none`, with `under-5s`, `5-30s`, `30s-2m`, `2-10m`, `over-10m`                                                                                                  |

The card holds no name, id, path, hash, count or free text from the estate. It is printed outside the run log, and no flag writes it to a file. `--json` gives `{ checks, card }` with the same words. `makeFieldEstate` (`packages/cli/test/field-estate.ts`) takes `shape: { repos, records, flags }` in the same words, imported from the same file, and reads `ATTICUS_FIELD_SHAPE`. Each band maps to one fixed size, and each flag adds its invented Forge shape.

**Out of scope, and never built:** any upload, telemetry or bundle that holds a name, id, path, hash, record, fact, code line or log line from a real estate. Whether even the card's words may be said outside the site is that organisation's decision. `atticus support bundle` stays as ADR 0050 made it.

## Contracts

- **C4, additive, local API 3.19.0.** New routes: `POST /api/support/bundle`, `GET /api/jobs`, `GET /api/status`. New parameters: `repo` and `rejected` on `GET /api/trust`. New optional fields: `Job.stoppable`, `Job.stopLands`, `Job.for`, the same two stop fields on `ActivityEntry`, `Task.why`, `Task.note`, `undo` on a local job's result and on a build route's 409, `atticus` in a refusal's `newer[]`, `standing` on a refusal. No field is removed or changes meaning. `docs/api/openapi.json` is generated again.
- **The command line (C4's surface census):** `atticus status`, `atticus selfcheck`, and one question in a terminal.
- **Not contracts:** the run record gains `longestQuietMs` (ADR 0187 keeps that file out of the contracts). `build.json` is not changed.

## Not decided here

- The Atticus that built a catalog is recorded only from the next `build.json` version on. Raising the version in beta.30 to record it now is the owner's choice (see the report with this ADR).
- A route that serves a job's lines after `atticus ui` restarts; the app listing every job kept.
- Saving the shape card to a file; any way for it to leave the machine.
- Selfcheck's invariants beyond these four (the twelve of ADR 0195 need a second world to compare with).
- The plan before a multi-repo action (item 4 of the field plan) and one repo's Apply in 15 seconds (slice 10).

## Tests that prove it (written first, failing)

- `cli/test/ui-api-support.test.ts`: the route's zip holds the files `bundleFiles` gives; nothing is fetched (the mock network is never called); the file is under `.atticus/logs/`.
- `server/test/jobs.test.ts` and `cli/test/ui-api-stop.test.ts`: `stoppable` and `stopLands` before a commit, after it, in a job of several inside and between writes, and once done. Propose stopped before its push leaves the mock Git host untouched and says its sentence; stopped after, it finishes. The same for Bring in.
- `cli/test/ui-api-undo-way.test.ts`: a failed Apply that took an undo copy carries `undo` with `ofThis: true`; a refused one carries the earlier build's with `ofThis: false`; a fresh metarepo carries none; a stale plan is 409.
- `cli/test/ui-api-trust.test.ts`: one repo, rejected only, uncapped; 404 and 400. `cli/test/ui-api-jobs.test.ts`: the running Apply of a repo found by `action` and `repo`; a finished one; none.
- `cli/test/ui-api-board.test.ts`: `why` for an unknown `(after …)`, a cycle and a run past; `note` for a title that ends in "after" words.
- `scanner/test/slots.test.ts` and `big-estate-equivalence.test.ts`: a version 3 `build.json` with `atticus` gives the exact command; without it, or with a value that isn't a version, `@beta`; the build's own `build.json` is byte for byte what beta.28.5 writes.
- `cli/test/standing.test.ts`: each of the five states from a made metarepo, with and without `ATTICUS_EXTENSION_NEEDS`; the line as the last line of each refusal; `--json` equals the route.
- `cli/test/confirm-once.test.ts`: with a fake `ask`, yes and no for each row of the table; a list changed between listing and answer writes nothing; without `ask`, with `--json` and with `CI` set the output is today's bytes and nothing is asked.
- `cli/test/selfcheck.test.ts`, on `field-estate.ts`: all four pass; each fails on a made fault and names its flag; the files under the metarepo are the same before and after but the log; no line of the default output or the card holds a repo id, record id or path of the estate (checked against every id the estate has). `shape-words.test.ts`: the card of an estate made from a shape gives that shape back.
- UI tests for each new state (empty, loading, error) and the accessibility checks.

## Migration

None. No stored file changes shape and no schema version moves. An older app against a newer server ignores the new fields; a newer app against an older server (no `stoppable`, no `undo`, a 404 on the new routes) shows what it shows today: Stop while running, the link to the Undo panel, the command to copy.

## Not verified

- No code was run. Whether a saved copy can be made from inside the editor's panel was not tried; the path and "Copy the path" are there for that.
- That `atticus doctor --counts` already tallies every call into drawn, loose and asked with nothing left over was read from its help text, not its code.
- Sizes, in lines that aren't tests: point 1 about 45, 2 about 70, 3 about 40, 4 about 35, 5 about 60, 6 about 15, 7 about 30, 8 about 110, 9 about 70, 10 about 240. That is about 265 for the app's seven and 420 for slice 7.
