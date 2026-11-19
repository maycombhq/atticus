# 0204. Connect A to B: one action on every box, and new repos in one go

- Status: accepted (2026-11-18, by the owner, with the recommended answers: a declared arrow lives in the profile's links list; once code shows the call the declared arrow stops being drawn at once and its line stays until the person retires it; why is required)
- Date: 2026-11-18
- Release: 2.0.0-beta.30, slice 5 of [the plan](../plan/v30.md); items 12 to 14 of [field reliability and ease](../plan/field-reliability-and-ease.md)
- Builds on: ADR 0174 (correcting the map on the canvas), ADR 0188 (a button for every step), ADR 0195 (source slots, one pure build), ADR 0198 (Apply takes the repos that wait), ADR 0199 (a read is a job; a pairing says where it stands), ADR 0200 (a line is never turned round)
- Closes: ADR 0200's "Not decided here" (declaring who calls an ordinary service; adding a system from the panel)
- Contracts: C6, the profile, version 3: one new optional list, `links`, with a migration that moves nothing. C4, the local API, additive only, in 3.19.0 (or the next free minor). C1 is unchanged in shape: a declared arrow is an Interface as C1 has it, with one new flag value. C2, C3, C5, the facts file and the corrections file are unchanged.

## Context

The owner, the product's main user, could not connect a gateway proxy's box to a Spring Boot service's box on a field estate. A repo's box offers only "Connect to…", which pairs calls read from code; the proxy's forwarding call had not been read, so there was nothing to pair. An outside system's box offers only "Declare a link…", and a declaration to a repo that is no gateway ends at "isn't supported yet". Nothing on either page could draw the arrow.

Where a connection can be made it takes seven or more clicks and three waits (read the candidates, preview, write, Apply, then find the arrow), and the pages use about twelve words for it: pair, declare, move, redirect, correct, loose call, curated, paired, left, asked, no route, not joined.

This ADR decides the smallest design that gives one action, "Connect A to B", on every box, makes writing and applying one step, fixes what is missing in place, and adds new repos in one go. It adds one stored list and one flag; everything else is the code that is there, called in a different order.

## How it is today

Read in the code on `release/b30` (2.0.0-beta.28.5 with beta.30 in progress; local API 3.17.0, `packages/core/src/api.ts:695`). UI paths are under `packages/ui/src/screens/architecture/` unless said.

**What a box offers.** The inspector gives a repo's box `onConnect` and an outside system's box `onDeclare`, never both (`Architecture.tsx:1127` to `:1141`; the buttons, `:1438` and `:1448`; the words `connect.open` "Connect to…" and `declare.open` "Declare a link…", `packages/ui/src/copy.ts:5987`, `:5803`). A drawn line goes through `connectDrawn` (`Architecture.tsx:1298`): repo to anything opens Connect, outside system to repo opens Declare, and five cases only say why not (`dropSeveral`, `dropNoRepo`, `dropTwoOutside`, `dropSameRepo`, `dropNeedsRepo`, `copy.ts:5991` to `:6000`).

**Every way to change a line, and where it lives.**

| #   | Mechanism                         | Page and request                                                                                      | Stored in                                                                                             | Drawn by                                                                                                                        |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Pair a call with an API           | `Connect.tsx` (`Pairing`, `:285`); `POST /api/links/connect` (`packages/cli/src/ui-api-links.ts:677`) | a `link` line in `facts/<repo>.corrections.jsonl` (`packages/core/src/schema/fact-corrections.ts:71`) | the join, flagged paired by a person                                                                                            |
| 2   | Move a call that has an arrow     | the same panel, "Move a call here"                                                                    | the same `link` line                                                                                  | the same                                                                                                                        |
| 3   | "All loose calls go there"        | the same request, `rule`                                                                              | a `/**` answer to the repo's open target question                                                     | the join, by the answer                                                                                                         |
| 4   | "None of these"                   | Correct (ADR 0181)                                                                                    | an `unlink` line in the corrections                                                                   | the call is left                                                                                                                |
| 5   | Declare who calls a gateway route | `Declare.tsx` (`:142`); `POST /api/declared-links` (`packages/cli/src/ui-api-declared.ts:219`)        | an item of the system's `calls` in `profile.yaml` (`packages/core/src/schema/orgpack.ts:1607`)        | `joinCallers` and `callerRecords` (`packages/core/src/facts-callers.ts:220`, `:465`): an Interface flagged `declared-caller`    |
| 6   | Declare a topic                   | the same panel                                                                                        | the system's `topics` in the profile                                                                  | the merge, marked `declared-topic`                                                                                              |
| 7   | Delete a link, Bring back         | `POST /api/links/delete`, `/api/links/deleted/undo`                                                   | one curated suppress per Interface in `catalog/curated/`                                              | the build's last overlay                                                                                                        |
| 8   | Redirect; several changes at once | `EditMap.tsx`; `POST /api/map/edits` (`packages/cli/src/ui-api-catalog.ts:456`)                       | what 1, 5 and 7 write                                                                                 | `applyMapEdits` (`packages/cli/src/catalog-build-commands.ts:1395`): checks, writes, builds once, takes back a write that fails |
| 9   | A fact is wrong, or edited        | Why is this linked?                                                                                   | `wrong` and `edit` lines in the corrections                                                           | the verifier                                                                                                                    |
| 10  | Match with Copilot                | `POST /api/links/match`                                                                               | proposals; then lines as in 1                                                                         | as 1                                                                                                                            |
| 11  | Add a system                      | `POST /api/boxes` (`ui-api-declared.ts:156`)                                                          | a System in the profile                                                                               | the merge                                                                                                                       |

**What can't be said.** A declaration lands only on a gateway route (`joinCallers`); the panel says "Declaring who calls an entry of <repo> isn't supported yet: only a gateway's routes can be declared" (`Declare.tsx:391` to `:399`, `declare.notGateway`, `copy.ts:5857`). Nothing declares an arrow between two repos, from a repo to an outside system with no spec, or between two outside systems. A curated decision can't add a record either, by ADR 0195's addendum (`catalog-build-commands.ts:772`): what a person adds is said "where the build reads it: a fact … or a rule in the org pack".

**Write, then Apply, then Propose are three steps.** After a write the page shows `WrittenNext` (`packages/ui/src/app/app-step.tsx:322`; used at `Connect.tsx:858`, `Declare.tsx:31`): the words, an Apply button and Propose. A pairing's Apply is `atticus verify <repo> --write` (`POST /api/facts/{repo}/apply`, `packages/cli/src/ui-api.ts:885`); a declaration's is `atticus verify --all --write`, every repo read (`POST /api/facts/apply-all`, `packages/cli/src/ui-api-steps.ts:93`). Only Edit the map (row 8) writes and builds in one job.

**Missing things send the person away.** "Open it and draw the line again" (`connect.dropSeveral`), "Add its repo with Add to the picture…, then draw the line" (`dropNoRepo`), "Read it first:" with a command (`connect.noApis`, `copy.ts:6025`), "Add it … then draw the line again" (`declare.noProfile`, `copy.ts:5874`), "Read the gateway's repo first" (`declare.noGateways`, `copy.ts:5837`).

**New repos are four pages.** `setup/AddRepos.tsx` reads the list (`POST /api/setup/repos/plan`, a job since ADR 0199) and writes the manifest (`POST /api/setup/repos`, `packages/cli/src/ui-api-setup.ts:352`), then says "propose it for review. Then clone them (Sync on Onboarding) and read each" (`:396`). Sync is `POST /api/workspace/sync` (`ui-api.ts:2088`), the read is a Copilot run (`POST /api/copilot-runs`) or a hand-off where `runtime.yaml` doesn't allow it (`packages/cli/src/ui-api-copilot-runs.ts:81`), and Apply is on the map's bar.

**Words.** A call has nine statuses (`CandidateCallView.status`, `api.ts:5393`; shown by `connect.status`, `copy.ts:6211`) and ten reasons it was left (`connect.leftWhy`, `copy.ts:6009`).

**Provenance, as C1 has it.** An Interface has `confidence` (`asserted`: stated by a person), free-text `flags`, and `evidence` whose `manual` source carries `by` (`packages/core/src/schema/common.ts:50`, `:91`, `:106`; `packages/core/src/schema/kinds.ts:110`). A declared caller's Interface is made again from the profile on every write, so a declaration taken back leaves nothing (`packages/scanner/src/facts-catalog.ts:1490`).

## Decision

### 1. One action, "Connect <A> to <B>", on every box and from a drawn line

1.1. Every repo, component, system and outside-system box has one button, **Connect to…** (`connect.open`). "Declare a link…" goes from the box; what it did for topics stays, under Details (5.1). A drawn line opens the same panel. `connectDrawn` returns the two boxes and never a refusal, except for one box drawn to itself and for a node that is no box (a topic, a table): `dropSameRepo` and `dropNeedsRepo` stay.

1.2. **Direction is chosen, never guessed.** The panel's first line is two radio buttons: "<A> calls <B>" and "<B> calls <A>". From a drawn line the box it started on is the caller and its radio is on; from the button the selected box is the caller. Only the person's click changes it (ADR 0200). The title is "Connect <caller> to <callee>".

1.3. **Atticus chooses the mechanism** from one request, `GET /api/connect?from=<box>&to=<box>` (a job, as the candidates read is), and says which in the panel's second line. `mechanism` is one of:

| `mechanism` | When                                                                                                                                                 | The panel says                                                                                                                                                        | The button                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `calls`     | the caller is a repo with calls on record, and at least one call with no arrow has a suggestion among the callee's APIs (`suggestion`, as today)     | "Atticus found N calls in <A>'s code that look like they go to <B>. The K it is sure of are ticked." Then the rows, and **None of these: declare the arrow instead**. | **Connect N calls**            |
| `connected` | calls of the caller already go to the callee with an arrow on the map, and none is loose                                                             | "<A> already calls <B>: N calls read from code. There is nothing to add." with **Show the arrow**                                                                     | none                           |
| `declared`  | the profile has this arrow already                                                                                                                   | "<name> declared this arrow on <date>: "<why>"." with **Remove it**                                                                                                   | none                           |
| `declare`   | every other case: no call looks like it goes there, the caller has no code on record, or either box is an outside system, a planned box, or not read | "Atticus found no call in <A>'s code that goes to <B>. You can still draw the arrow: it will be your word, drawn dashed and marked "declared by <name>"."             | **Connect: declare the arrow** |
| `needs`     | the box named is no single box yet (3.1)                                                                                                             | what is missing, with the control that fixes it                                                                                                                       | per row of 3.1                 |

Ticks are the existing rule: only confident pairs start ticked (`initialPicks`). The rows, the preview and the write of `calls` are today's pairing, unchanged. An outside system as the caller of a repo that has gateway routes gets `declare` with one more fold, "Say which routes (optional)", which is ADR 0200's route list; routes ticked are written as today's `calls` items, none ticked as the arrow of 1.4.

1.4. **A declared arrow is one item of a new list, `links`, in `profile.yaml`** (C6, version 3):

```yaml
links:
  - from: { repo: forge-edge-proxy } # or { system: <id> }
    to: { repo: forge-ledger-svc } # or { system: <id> }
    why: The proxy's target is set at deploy time; the platform team confirmed it.
    by: Ada Example
    at: 2026-11-18T10:02:00Z
    planned: true # optional: not built yet
```

- `from` and `to` each name a repo of the manifests or a system of the profiles, one of the two; they differ; a pair (`from`, `to`) is listed once. `why` is 3 to 500 characters and required. `by` is the Git user, `at` the instant; both are data, not a comment, so the map can say who.
- It is written to the profile of the caller's platform (the manifest that lists the repo, or the profile that has the system), else the callee's. The write is `declareLink`'s: comments and order kept, previewed line by line, refused whole if the file changed.
- Why the profile and not the corrections file: a correction is about one fact of one repo's code (`fact` and `target` are required), and a declared arrow has no fact; an outside system has no corrections file. Why not `systems[].calls`: that item names a gateway route, not a box, and a repo-to-repo arrow would have to invent a System to hang from. Both stay as they are.

1.5. **In the catalog** the build makes, for each item, one Interface, again on every build and never kept on its own: `from` and `to` are the two boxes' records (a repo's component, where the repo has several the one the repo's box is drawn as; a system's System), `via: other`, `normalizedPath: /**`, no method, `sync: sync`, `confidence: asserted`, `status: planned-new` when `planned` else `current`, `flags: [declared-link]`, and exactly one piece of evidence, `{ source: manual, path: profiles/<platform>/profile.yaml, by: <name> }`. It cites no line of code and is never `verified`. `declared-link` joins the flags that say how a link was made and are never a gap (`JOIN_HOW_FLAGS`). A declared arrow carries no call onward: it is in no flow, no chain of gateways and no impact path as a call would be; impact lists it as "declared by a person".

1.6. **On the map** it is a dashed line labelled "declared by <name>", in the "declared" layer, and its panel says: "<name> declared on <date> that <A> calls <B>: "<why>". No code was read for this arrow." The label carries the meaning, not the dash alone.

1.7. **When the code later shows a real call.** A real call is any Interface between the same two boxes in the same direction that has neither `declared-link` nor `declared-caller` (read from code, or a call a person or the AI paired: both cite the caller's line). The build then does not write the declared Interface, so there is one arrow, the code's, and lists the item under `declaredSuperseded` in the build's report. Nothing in the profile changes: a person's file is changed only by a person. Wherever the arrow or either box is open, and in a count above the map ("1 declared arrow the code now shows"), the page says: "The code now shows <A> calling <B> (N calls). The arrow <name> declared on <date> is no longer needed." with **Retire the declared arrow**, which previews and removes exactly that item. If the call goes away again before it is retired, the declared arrow is drawn again. A call in the other direction retires nothing. Declaring an arrow where a real call exists is refused (409) with the `connected` words.

1.8. An item naming a repo or system the manifests and profiles no longer have is reported by the build ("declared arrow to <id>, which is no longer here") and kept, as an orphaned curated decision is.

### 2. Write and Apply are one action; Propose stays its own

2.1. The panel's one button (1.3) does four things in order and says each: **preview**, **write**, **apply**, **show**. The preview is today's (`preview: true`): the lines that will be written and what the map gains, moves and loses. With nothing removed and nothing replaced, the button goes straight on; the lines stay on the page under "What was written".

2.2. The write and the apply are one job, `POST /api/map/edits` with one edit (a `pair` as today, or the new `link`): checked first, written, the catalog built once, and a failed write taken back (`applyMapEdits`). A declared arrow no longer needs `verify --all --write`.

2.3. **The confirms that exist are kept, each before anything is written:** a pairing that replaces another person's word ("pairing it here replaces their word"); a move that takes an arrow away from another box; a build that would remove more than its guard allows or finds hand edits (the job ends "saved, not built" with the listing and the existing **Review the removals** and **Keep my edits**); facts the write would leave out. A refusal is said with its one button forward.

2.4. When the job ends the panel says "Connected: <A> → <B> is on the map." with **Show the arrow** (the canvas selects it), **Undo** and **Propose for review**. Undo is one job, `POST /api/map/edits/undo`: it removes exactly the lines this action wrote if they are still as written, and builds once; otherwise it says what changed since and removes nothing.

2.5. **What is local and what is shared.** Local, done by the button: the profile or corrections file (and the answers file for 5.1's rule) in this metarepo's working tree, `catalog/generated`, `build.json` and the build's undo copy. No commit, no push, no network. Shared, done only by **Propose for review**: a branch, a commit, a push and a pull request a human approves (hard rule 6). Until then the page says "Not proposed yet: only this machine has it."

### 3. What is missing is fixed in the panel

3.1. `GET /api/connect` answers `needs`, a list, and the panel shows the control for each and continues with the same two boxes when it is done:

| Today's words                                                        | `needs`      | In the panel                                                                                                                                                                     |
| -------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect.dropSeveral`                                                | `pick-repo`  | "<system> holds N repos. Which one?" and its repos as radio buttons                                                                                                              |
| `connect.dropNoRepo`                                                 | `no-repo`    | "<system> has no repo on the map yet." **Connect to <system> itself** (a declared arrow, "Not built yet" ticked) or **Add its repo…** (decision 4's form, in the panel)          |
| `connect.noCalls`, `connect.noApis` `not-read`                       | `read`       | "<B> hasn't been read yet." **Read <B> now** (`ReadRepo`, with the run's progress and Stop), then the panel reads the two boxes again. **Declare the arrow now** stays beside it |
| `connect.unverifiedCalls`, `connect.noApis` `unverified`             | `verify`     | **Check <B>'s facts now** (`POST /api/facts/{repo}/apply`), then on                                                                                                              |
| `connect.noApis` `no-spec`                                           | none         | not a block any more: `declare`, with "Add <system>'s OpenAPI file…" under Details                                                                                               |
| `declare.noProfile`                                                  | `add-system` | "<label> is on the map because code names it." **Add <label> and continue**: the System is added in the same write as the arrow, shown in the preview                            |
| `declare.noGateways`, `declare.notGateway`, `connect.dropTwoOutside` | none         | not a block any more: the arrow is declared between the two boxes                                                                                                                |

3.2. `needs` never hides `declare`: where a read would take minutes, the person can declare the arrow now and the code retires it later (1.7).

### 4. Add, sync, read and apply new repos as one action

4.1. On `setup/AddRepos.tsx`, once the list is read and ticked, the button is **Sync, read and apply these N**. The list on the page is the preview of the manifest's lines, as today. **Add only** stays beside it.

4.2. It is one job, `POST /api/setup/repos/run`, of four parts, each the existing code: **Add** (`addManifestRepos`), **Sync** (the workspace sync, for these repos), **Read** (the assistant, 4.4), **Apply** (`verify <repo> --write` for these repos, in name order, ADR 0198). The page shows: "Part 3 of 4: reading forge-ledger-svc (2 of 5). About 6 minutes left." Time left is the rate so far (`timeLeftWords`); before a part's first repo ends it says "No estimate yet."

4.3. **Stop** is heard between parts and between repos (a sync's Stop ends its git and takes a half-made clone away; an Apply's ends after the repo being written). What is done stays done. The parts are worked out from what is on disk (listed, cloned, facts on file, applied), so the button then reads **Continue: N left**, and the same request picks up where it stopped.

4.4. **Reading needs the assistant** (hard rule 4). Where `runtime.yaml` allows the app to start it, the part is one unattended run for these repos, after the same yes the run asks for today. Where it doesn't, the job pauses, not fails: "Atticus can't start your assistant on this machine. Paste this into Copilot Chat or Claude Code:" with the command, and **I've read them: continue**, which checks that each repo's facts are on file and goes on to Apply; a repo with none is listed and left for later. The built-in readers are not used in its place.

4.5. A repo that fails a part (a clone refused, a read cut short, facts rejected) is listed with why and its one button; the others go on. At the end: "N of M are on the map." with **Show them** and **Propose for review**. Nothing here commits or pushes.

### 5. What stays under Details, and fewer words

5.1. One fold, **Details**, at the foot of the panel keeps every capability: Move a call here; All loose calls go there; Match with Copilot; the calls with no suggestion; each call's exact status and reason; the typed route; "Publishes or listens on a topic…" (an outside system's); what the AI paired between the two boxes. Edit the map (several changes, redirect, delete) stays where it is.

5.2. **Nine statuses are shown as four.** The API's values don't change; the exact one is the row's detail.

| Shown               | `status`                                                      |
| ------------------- | ------------------------------------------------------------- |
| no arrow yet        | `asked`, `missed`, `left`, `outside`, `unresolved`, `undrawn` |
| goes to <box>       | `joined`                                                      |
| goes here already   | `here`                                                        |
| connected by <name> | `paired` (the AI's: "connected by AI, not confirmed")         |

5.3. **Ten reasons are shown as four**, the exact one kept as the row's detail in today's words.

| Shown                          | `why`                                                                 |
| ------------------------------ | --------------------------------------------------------------------- |
| its address isn't known        | `no-host`, `unresolved-placeholder`, `topic-unresolved`               |
| nothing on the map serves it   | `host-no-route`, `label-no-route`, `target-no-route`, `topic-unheard` |
| Atticus can't match this kind  | `generic-path`, `type-not-joined`                                     |
| you said it calls nothing here | `answered-none`                                                       |

5.4. In this panel the verbs are "connect" and "declare the arrow". "Pair", "loose call", "move" and "redirect" appear only under Details. The wider renaming is slice 8's.

## Contracts, version bumps, Local API additions

- **C6.** `PROFILE_SCHEMA_VERSION` 3. `Profile` gains optional `links` (1.4); `links` on a version 1 or 2 profile is refused with "links needs schemaVersion 3: set schemaVersion: 3, nothing else changes", as `topics` is for 2. Versions 1 and 2 stay valid.
- **C1.** No schema change and no version bump: one more flag value, `declared-link`, on an Interface C1 already allows. The reason (`why`) and the date live in the profile; the API reads them from there.
- **C4, local API 3.19.0, additive.** `GET /api/connect` (`ConnectView`: the two boxes, `mechanism`, `needs`, the existing `LinkCandidatesView` when the caller has code, `existing` code calls, `declared` with who, when and why, `superseded`). `DeclareLinkRequest` and `MapEditAdd` gain `kind: link` (`from`, `to`, `why`, `planned`, and `preview` on the first). `POST /api/declared-links/undo` takes a `link`. `POST /api/map/edits/undo`. `MapEditsResult` gains `wrote` (what Undo names). `POST /api/setup/repos/run` and its result (`parts`, each with its repos and state: `done`, `waiting`, `stopped`, `failed`). `GET /api/boxes/corrections` lists a box's declared arrows, at either end. The build report gains `declaredSuperseded`. Nothing is removed or renamed: an older page keeps working.

## Migration

Nothing is moved. A profile at version 1 or 2 reads as it is; the first declared arrow writes `schemaVersion: 3` and the `links` list (`migrateProfileText`, the number only, comments and layout kept). Existing `calls` items, `topics`, corrections files and curated decisions are not touched, and existing declared callers are drawn as before. `atticus upgrade` has no step. A beta.28.5 metarepo opened by beta.30 builds a catalog byte for byte the same until an arrow is declared. An older Atticus refuses a version 3 profile by its version number, so a team upgrades before it merges the first declared arrow; the Propose page says so when the proposal raises the profile's version.

## Not decided here

- A declared arrow that carries calls: a method and path on it, a place in flows, or callers of a gateway carried on through a declared forward. The proxy-to-service case gets its arrow; the route-by-route forwarding is still the open question's answer or a pairing.
- Setting a repo's type from the app (ADR 0200).
- Using the built-in readers to put a new repo on the map before the assistant has read it.
- Declared arrows for another team's shared map (ADR 0160).

## Tests that prove it (written first, failing)

- **Unit, core.** The profile schema: `links` valid and each refusal (same ends, a pair twice, both or neither of repo and system, `why` missing, version 2 with `links`). `declareLink` for a link: preview equals write, comments kept, refused on a changed file, undo removes exactly its item and leaves a hand-edited one. The records: one Interface with the fields of 1.5 and one `manual` evidence; made again each build; gone when the item is. Supersede: a code call the same way hides it and reports it; the other way doesn't; taking the call away draws it again; a pairing counts as a real call. An orphaned item is reported and kept. Determinism: the same profile and slots build the same bytes.
- **Unit, API.** `GET /api/connect` gives each `mechanism` and each `needs` of 3.1 on a fixture made for it; direction is the request's and never swapped (a property test over every pair of box kinds). `POST /api/map/edits` with a `link`: written and built once; a refused build leaves it saved with the listing; Undo after it; Undo refused when the line changed. The repos run: its parts from disk, Stop between parts, Continue, the hand-off pause, one repo failing while the rest go on. Every external system behind its mock (hard rule 5).
- **Unit, UI.** The panel for each mechanism and need, with loading, empty and error states and the accessibility checks; one Connect button on every kind of box; four status words and four reasons, the exact one in the detail; the dashed line's label.
- **Journeys** (on the field-shaped estate, `packages/cli/test/field-estate.ts`): (1) connect a gateway proxy to a service that is no gateway, whose forwarding call was not read: one button, the arrow dashed and "declared by", Undo, then again and Propose; (2) connect two boxes with no calls, each pair of kinds: repo to outside system with no spec, two outside systems, a system with no repo as planned; (3) the service's caller is read later and shows the call: one solid arrow, the offer to retire, Retire, and the profile no longer has the item; (4) connect where calls exist: ticked, one button, on the map, `PairedStanding` says so without a second Apply; (5) three new repos from a folder: one button to the map, Stop after Sync, Continue, and the hand-off pause where the app can't start the assistant.
- **Upgrade.** A beta.28.5 metarepo with hand pairings, declared gateway routes and topics: opened, built, and every file byte for byte the same; then one declared arrow raises only the profile's version and adds its item.

## Risks, and rough size (lines that aren't tests)

| Decision | New                                                                                                                                                                 | Reuse                                                                                              | About |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----- |
| 1        | the `links` schema, its write and undo, the Interface and the supersede rule; `GET /api/connect`; the panel's mechanism line, the declare form and the retire offer | `declareLink`, `candidatesOf`, `Pairing`, the route list, the declared layer and dashed line       | 450   |
| 2        | the Undo request; the panel's four steps                                                                                                                            | `POST /api/map/edits`, `applyMapEdits`, the previews, the build's confirms                         | 120   |
| 3        | the `needs` list and its five controls                                                                                                                              | `ReadRepo`, the box form, the repo list, Apply                                                     | 120   |
| 4        | the run's parts and its request; the page's progress and Continue                                                                                                   | `addManifestRepos`, the sync, the Copilot run and hand-off, Apply for named repos, `timeLeftWords` | 230   |
| 5        | the Details fold and two word tables in the copy file                                                                                                               | everything under the fold                                                                          | 80    |

About 1,000 lines, the plan's figure for slice 5.

- **The riskiest part is 1.5 with 1.7**: which record each end of a declared arrow is, so that the map draws it between exactly the two boxes at every lens, and "the same two boxes" for the supersede rule when a repo has several components or the call goes through a gateway. Journeys 1 and 3 pin both; if they can't be made to hold simply, the arrow is drawn between the boxes' Systems only and the ADR is amended before more code.
- A declared arrow reads as truth to someone who doesn't look closely. The label, the layer, `asserted`, the single `manual` evidence and impact's words are the guard; a declared arrow is never counted with links read from code.
- `applyMapEdits` builds; it does not run `verify --write`. A pairing made this way must read as "on the map" at once (`applyPending`, ADR 0199); journey 4 checks it.
- The run of decision 4 spans three kinds of job (sync, a Copilot run, Apply). It holds Apply's slot for its whole length, so nothing else applies meanwhile; Stop must reach whichever part is running.
- Profiles are reviewed as the org pack; arrows declared by any engineer now arrive there, as declared routes already do.
