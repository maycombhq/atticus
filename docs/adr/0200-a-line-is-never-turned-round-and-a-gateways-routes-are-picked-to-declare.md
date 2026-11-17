# 0200. A line is never turned round, and a gateway's routes are picked to declare who calls them

- Status: proposed (2026-11-17)
- Date: 2026-11-17
- Release: the next beta after 2.0.0-beta.28.4
- Builds on: ADR 0174 (correcting the map on the canvas: G1 connect, G3 declare a link), ADR 0124 addendum A-callers (a declared caller of a gateway route), ADR 0199 (a pairing says where it stands)
- Contracts: C4, the local API, additive only, in version 3.17.0. No stored file changes shape: a declaration is still one item of a system's `calls` in the profile (C6, unchanged), so there is no migration. C1, C2, C3, C5, C6 and the facts file are unchanged.

## Context

A field report on 2.0.0-beta.28.4. Another team's system (a box with no code in the estate; here, Harbor Audit) calls one of the estate's gateway proxy repos. The person drew a line from the system to the proxy's repo: the right direction.

The panel that opened was "Connect <the proxy> to another box", with the proxy as the caller. It said the system had no spec on file, that every call of the proxy had an arrow already and to pick an API under "Move a call here" (there was none), and offered "Write 0 pairs". What the person drew had been turned round without a word, and nothing on the page could be done.

The cause, in the code: `connectDrawn` swapped the ends of a line that started on an outside system, because Connect pairs calls read from a repo's code and an outside system has none. The tool for what the person meant was there and not offered: Declare a link (ADR 0174, G3), "Calls a gateway route", which until now took the route typed by hand as `METHOD /path`.

## Decision

### 1. The box a line starts on is the caller, always

`connectDrawn` (`packages/ui/src/screens/architecture/Architecture.tsx`) never swaps. A system of the estate holding exactly one repo means that repo, and a component means its repo, as before.

| The line starts on              | and ends on                        | What opens, or is said                                                                             |
| ------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| a repo                          | another repo                       | Connect: the first repo's calls paired with the other's APIs (as before)                           |
| a repo                          | an outside system                  | Connect: the repo's calls paired with the system's spec (as before)                                |
| an outside system               | a repo                             | Declare a link: the system as the caller, "Calls a gateway route" chosen, the repo's routes listed |
| an outside system               | another outside system             | said: neither has code in the estate; pick the first and choose Declare a link…                    |
| a system with several repos     | anything (or the other way round)  | said, by name: open it (double-click) and draw to or from the repo inside                          |
| a system of the estate, no repo | anything (or the other way round)  | said, by name: add its repo with Add to the picture…, then draw to or from the repo                |
| a repo                          | itself (its system, its component) | said: both ends are in the same repo (as before)                                                   |
| a box that is none of these     | anything                           | said: a line is drawn from the caller to what it calls, between repos, components and systems      |

### 2. A declared call lands only on a gateway route, and the panel says so

What the join does today (`joinCallers`, `packages/core/src/facts-callers.ts`): a system's declared call is placed on the **gateway routes** it names and nowhere else. A gateway route is an entry fact of a repo whose manifest type is `gateway` (or `gateway-…`), or any repo's entry cited under a proxy bundle folder (the estate's conventions). The declaration names the route by `METHOD /path` as the gateway serves it (`ANY` for a route read with no method) or by its handler (`proxy/flow`); it does not name a repo, so the same words served by two gateways land on both. The Interface is drawn from the system to what the route forwards to (the service behind the gateway, when the gateway's forwarding call is joined), else to the gateway's own component; `via: gateway`, flagged `declared-caller`, `asserted`, and the map says "A person declared who calls this gateway route."

An ordinary service's entry is not a gateway route, and no declaration can land on it. This ADR does not widen that: it would not be additive (see "Not decided here"). The panel says the truth instead: "Declaring who calls an entry of <repo> isn't supported yet: only a gateway's routes can be declared", how many entries the repo has, and what does work (the gateway in front of it, the line the other way for the repo's own calls, a topic).

### 3. The routes are listed to pick from

`GET /api/declared-links/routes?system=<id>[&repo=<repo>]` (new) answers `DeclarableRoutesView`:

- `system`: the system the box is (a repo's id names the system its box is drawn as, as the write does);
- `inProfile`: a profile has the system, or the write adds it first (a repo's own box); false for a system only the code names, whose declaration would be refused;
- `gateways`: the repos that have gateway routes, by id, with how many;
- `target` (with `repo`): `gateway` (it has routes), `routes` by path then method, `entries` (how many entries it has on record, routes or not), the repo's manifest `type` and the `manifest` file that says it, `looksLikeGateway` (below), and `notRead` with the step that reads or verifies it when nothing of it is on record.

Each route carries its entry fact's id, `method`, `path`, `handler` where the facts name one, `at` (the line it was read from), `say` (the words that declare it), `declared` when the system's profile has it already (by either way of naming it), and `also` (the other repos whose route the same words name).

The list comes from the verified facts on file (`estateFacts`), by the join's own rule for a gateway route (`gatewayRouteFacts`, the one rule now shared with `joinCallers`), and `say` is checked against the join's own matcher (`declaredRouteMatches`): `METHOD /path` where no other route of the estate is served on those words, else the handler where that names only this route, else `METHOD /path` with `also` saying where else it lands. Connect's list of a box's APIs (`boxApis`) was not reused for the rule: it tells a gateway by a looser reading of the repo's type than the join does, and would have offered routes a declaration can't land on. It reads the same facts.

No join is run and no catalog is read: the request is not a job.

**Where Connect and the join disagree on what a gateway is.** Connect calls a box's entries routes when the repo's type merely reads like a gateway's (`api-gateway`, `reverse-proxy`, `apigee`, `kong-gateway`: `looksLikeGatewayType`, `packages/cli/src/ui-api-links.ts`). The join takes only `gateway` or `gateway-…`, or a proxy bundle folder, and the join is the rule a declaration lands by; it is not loosened here. For a repo the loose rule calls a gateway and the join doesn't, `target.looksLikeGateway` is true and the panel says why and the step that works, in place of "isn't supported yet": set `type: gateway` for the repo in its `repos.manifest.yaml`, then draw the line again. Checked by test: the routes are listed as soon as the manifest says `gateway` (the list reads the manifest and the facts on file, so no Apply is needed first), and a declaration then lands on them at the next Apply. Nothing in the app sets a repo's type yet: it is an edit of the manifest, for review like any other.

### 4. Several routes are declared in one write

`POST /api/declared-links`, for `kind: call`, takes `routes` (1 to 200) in place of `route`. Each route is one item of the system's `calls`, with who and when as its comment, as one declaration is. They are written once each, sorted, whatever order they come in, in one write of the profile; `preview: true` answers the same lines and writes nothing. If the profile has one of them already the request is refused whole (409, naming each) and nothing is written. Neither `route` nor `routes`, or both, is 400. A request with `route` answers as before, so an older page keeps working. A System the canvas adds first (beta.28.1, `created`) is added as before.

### 5. The panel

Declare a link (`DeclarePanel`, `packages/ui/src/screens/architecture/Declare.tsx`), when "Calls a gateway route" is chosen: the gateway is picked first (only repos that have gateway routes; the repo a line ended on is named even when it has none), then its routes are ticked. More than eight routes get a search by method, path or handler; what is ticked stays in sight. Routes declared already are listed apart, marked, with no tick box. Two routes of one gateway that the same words name (no handler tells them apart) are one row with both handlers and lines, since one declaration is for both, so the count of routes ticked is the count of lines written. The typed form, once opened, stays open. The typed form stays, folded, for a route not read yet. Preview shows every line together; Write it writes exactly what was previewed (a tick changed since asks for a new preview). Opened by a line, the panel names the two ends as drawn, the system first. Loading, failure (with Try again), no gateway at all, nothing on record and every-route-declared each have their words.

After the write the words and the Apply are the existing ones (ADR 0188's `WrittenNext`); Undo stays under Corrections and declarations on the system's box.

### 6. Connect never offers a write that writes nothing

Connect (`Pairing`, `Connect.tsx`), when the other box has no API on record: "Every call of this repo has an arrow already (…): nothing is loose, and <box> has no API on record to move one to" (it no longer points at a "Move a call here" list that isn't there), or how many calls are loose with nothing to pair them with. When the other box is an outside system: "If <system> calls <repo>, drag the line from <system> to <repo>, or pick <system> and choose Declare a link…". No Preview or write button is shown where nothing could be written. Where something could, both are off until a pair is ticked, with the reason beside them, and the button never reads "Write 0 pairs". `PairedStanding` (ADR 0199) is untouched.

## Not decided here

**Declaring who calls an ordinary service's entry.** It needs, at least: a way to name the repo in the profile's `calls` (C6: `METHOD /path` alone is not unique across services, `GET /health` is served by most), the join placing a declaration on an entry that is not a gateway route (`joinCallers` builds its routes, its "callers unknown" question and its chains for gateway routes only), an Interface with no gateway route (`callerRecords` writes `via: gateway` and the route's id), and the rule that makes a declared Interface again from the profile each time its repo is written (`facts-catalog.ts`, today for gateway repos). That is a contract change to C6 with its own ADR, not an additive one.

**Adding a system no profile has, from the panel.** A box the map draws for a system only the code names (in no profile) can be drawn from. The write would answer "No system of the profiles is <id>", so the panel says so before anything is ticked (`inProfile: false`), holds Preview and Write back, and names the step: Add to the picture…, a new system with that id (`POST /api/boxes`; checked by test that the declaration is then taken), then draw the line again. Doing that step from the Declare panel itself is left for later.

**Setting a repo's type from the app.** See section 3: it is an edit of the manifest today.

## Consequences

- What a person draws is what the panel is about. A line from an outside system to a repo is no longer a Connect panel with the ends swapped.
- The same rule says what a gateway route is for the join and for the list, so a route offered is one the declaration lands on.
- An older page (sending `route`) and a newer server work together; a newer page against an older server would have `routes` ignored and be refused for the missing `route` (the page and its server ship together).
