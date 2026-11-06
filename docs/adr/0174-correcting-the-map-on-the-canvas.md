# 0174. Correcting the map on the canvas: connect two boxes, set an owner, add a box and declare a link

- Status: accepted (pending review by the product owner)
- Date: 2026-11-06
- Builds on: ADR 0124 (facts), its addendum D-app (Correct this), 0135 (C2: a person's target outranks the join's rules), 0149 (the correction preview), 0153 (answers by rule), 0162 (systems and topics in the profile)
- Contracts: the corrections file gains an action (`link`), additive; C4 (local API 2.53.0) gains the candidates, connect and undo calls, the owner and system call and declared links; C6's profile system topics gain `publishes` and `listens` and a declaration's author, with a migration

## Context

The first full run on a real estate of about 40 repos showed wrong pictures a person could see and fix only from the terminal: calls whose paths were field names or settings, so nothing matched the gateway's routes, and hundreds of questions answered one by one still drew no line; a proxy with 119 routes and no forwarding calls; ownership and topic links no code shows.

## Decision

### G1: connect two boxes, call by call

From a box, **Connect to…** (or a drag on the canvas) opens a panel for the pair: box A's calls that join nothing (asked, missed, left, unresolved), box B's APIs (a service's entries, a gateway's routes, an outside system's operations from its intaken spec), and for each call the API it most likely is: the same path, the same but for a prefix, a `{param}` or a setting, or a name whose words match (`captureChargePath` and `/partners/northwind/charges/{chargeId}/capture`). Two equally likely APIs suggest nothing.

Each pair the person confirms is **one `link` line in A's corrections file** (`facts/<A>.corrections.jsonl`): the call, as the correction names any fact (its id and what it cites), and what it reaches (the repo and the entry's id, method and path; or the outside system and the operation's method and path). The call's fact stays exactly as read and is still checked on its line: a link sets nothing on it. The join reads the links before anything else: the entry by id, else by method and path (a later read that gave it another id), and draws the link flagged `joined-by-person`; an entry no longer there is a miss that says who paired it. A link that meets no call is stale, said by the verifier, and kept.

**All** answers A's open target question with `/**` to B (ADR 0153), so calls read later follow it too. Before anything is written, the panel shows the lines and what the next `atticus verify A --write` adds, moves and removes (the ADR 0149 preview, run with the lines not yet written). When A has no calls on record, or B no APIs, the panel says so with the command that reads them (`atticus map --all --gaps --repos A`, `atticus map --all --repos B`) or adds the spec (`atticus intake add`).

### G2: a repo's owner and system

A repo's box has **Owner** and **System** pickers: the teams in roles.yaml and the systems of the profiles. Choosing one writes the repo's `owner` (or `system`) in repos.manifest.yaml after the person's yes, the change shown as a diff first. An owner no team file names is offered as **Add a team…**, written to roles.yaml for review.

### G3: add a box, declare a link

**Add to the picture…** offers what isn't drawn: a repo of the manifest, a system of the profiles, a team, or a new vendor or team system (written to the profile with `--add-system`, as ADR 0162 does). **Declare a link** from a team, vendor or system box to a topic (or back) writes the topic under that system's `topics:` with `publishes` or `listens`, who declared it and when. It is drawn dashed, Why is this linked? names who declared it and where it is written, a declaration the code later shows too is marked confirmed by code, and one the code contradicts is flagged, never dropped silently. Nothing here writes a fact.

### Undo, and who may correct

Every line a person writes from the canvas is listed under the box's **Corrections** with **Undo**, which removes exactly that line (`POST /api/facts/{repo}/corrections/undo`). Anyone who can open the app may correct, as with Correct this; roles.yaml can narrow it later.

## Consequences

- One mechanism for every pair, a question open or not; the facts file stays what the assistant read and cited (CLAUDE.md rule 4), and a person's word is never passed off as read from code.
- A pairing to a gateway route lets the walk through the gateway continue past it, so the contract check has both sides of each paired call.
- `atticus upgrade` migrates profiles to the new topic fields; older corrections files need nothing.
