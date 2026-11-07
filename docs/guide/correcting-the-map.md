# Correcting the map on the canvas

The map is read from code, and sometimes the code can't say where a call goes, who owns a repo, or who publishes to a topic. You can say it on the canvas (Map › Estate). Everything you say is your word: written to a file in the metarepo for review, shown before it is written, drawn dashed and never passed off as read from code. Every change can be undone (ADR 0174).

## Connect two boxes, call by call

Select a repo's box and choose **Connect to…**, or draw a line from one box to another on the canvas. Pick the other box: a repo of the manifest or an outside system.

The panel lists this repo's calls that join nothing (asked, no route, left or not joined), with the other box's APIs: a service's entries, a gateway's routes, or an outside system's operations from its intaken spec. For each call the likeliest API is picked already, and the panel says why: the same path (a `/v1` or `/v2` in front doesn't count), the same once the call's setting is filled in from the repo's config (`${refunds.base}/request`), the same but for a prefix or a parameter, what a gateway's route forwards to, the operation's name saying the same as the call site's constant, or names alike (`captureChargePath` and `/partners/northwind/charges/{chargeId}/capture`). Each call's select lists its three likeliest APIs first; with many APIs, a search box narrows the rest.

A pair is **confident** when the best match is sure and well ahead of every other API. Only those start ticked; **Tick the N confident** and **Tick all suggested** tick many at once, and one Preview and one Write pair them all. Change any pick, and untick what you don't agree with.

**Preview** shows the lines that will be written and what the next `atticus verify <repo> --write` adds, moves and removes. **Write** appends one `link` line per pair to `facts/<repo>.corrections.jsonl`. The call's own fact stays exactly as read. The join reads the link and draws the line, flagged as paired by a person; when a later read renames the API, it is found again by its method and path, and when it is gone, the box says so.

When the repo has an open target question, **All loose calls go there** answers it with `/**`, so calls read later follow it too.

When one side has nothing on record, the panel says so and gives the command: `atticus map --all --gaps --repos <repo>` to read the calls, `atticus map --all --repos <repo>` to read the other repo, or `atticus intake add` for an outside system's spec.

## A repo's owner and system

On a repo's box, **Owner and system…** picks a team from roles.yaml and a system of the profiles. **Preview** shows the lines that change; **Write it** edits the repo's manifest in place, its comments kept. **Add a team…** adds a team roles.yaml doesn't have yet, for review, with nobody on it. The map shows the change after `atticus verify --all --write`.

## Add a box, and declare a link

**Add to the picture…** (above the canvas) lists the manifest's repos not read yet, each with a button to read it with Copilot (when the app can start Copilot) and the command, and adds a new vendor or another team's system to the profile, for review.

On a system's box, **Declare a link…** says what the code can't show: the system publishes to a topic or queue, listens on one, or calls a gateway route (`METHOD /path`). It is written to the profile under the system's `topics` or `calls`, with your name and the date as the line's comment. A declared topic is drawn where a repo of the estate publishes or listens on it with nobody on the other side, dashed and marked declared. A system whose repos are in the manifest needs no declaration: read its code.

## Corrections, and Undo

Every box lists its corrections (a repo's) or declarations (a system's) under **Corrections and declarations**, each with who and when. **Undo** removes exactly the line it wrote; a topic or route written into the profile by hand is changed there, not by Undo. Undoing a pairing doesn't undo a `/**` answer written with it: change that answer on the Questions page. Each change ends with the command to redraw the map and the `git` command to commit the file.

## Working on the canvas

**Layers, filters and tools** above the canvas (ADR 0175) choose what is drawn and help you find your way; none of them changes the map.

- **Layers**: read and cited, guesses and gaps, declared, paired by a person, outside systems, topics, or only the links whose two sides disagree.
- **Filter**: `team:team-ledger`, `system:ledger`, `type:spring-boot`, `path:/accounts/**`, or words; the boxes that match and what they link to.
- **Colour boxes by** gaps or open questions.
- **Blast radius** of the selected box: what calls it, what it calls, or both, to a depth; the rest is dimmed.
- **Trace** from the selected box, hop by hop.
- **Open on this picture**: every box and link with a gap, most first.
- **Compare**: keep a snapshot, change something (pair calls, run verify), then mark what changed since.
- **Saved views**: keep the filter, layers and colouring by name in `diagrams/views/`; commit the file to share it.
- **Export** the picture as Mermaid, draw.io, SVG, PNG, or print it to PDF.
- A box's citations have **Open in your editor**: the file at its line in VS Code or IntelliJ.
