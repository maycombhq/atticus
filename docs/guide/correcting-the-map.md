# Correcting the map on the canvas

The map is read from code, and sometimes the code can't say where a call goes, who owns a repo, or who publishes to a topic. You can say it on the canvas (Map › Estate). Everything you say is your word: written to a file in the metarepo for review, shown before it is written, drawn dashed and never passed off as read from code. Every change can be undone (ADR 0174).

## Connect two boxes, call by call

Select a repo's box and choose **Connect to…**, or draw a line from one box to another on the canvas. Pick the other box: a repo of the manifest or an outside system.

The panel lists this repo's calls that join nothing (asked, no route, left or not joined), with the other box's APIs: a service's entries, a gateway's routes, or an outside system's operations from its intaken spec. For each call the likeliest API is picked already, and the panel says why: the same path (a `/v1` or `/v2` in front doesn't count), the same once the call's setting is filled in from the repo's config (`${refunds.base}/request`), the same but for a prefix or a parameter, what a gateway's route forwards to, the operation's name saying the same as the call site's constant, or names alike (`captureChargePath` and `/partners/northwind/charges/{chargeId}/capture`). Each call's select lists its three likeliest APIs first; with many APIs, a search box narrows the rest.

A pair is **confident** when the best match is sure and well ahead of every other API. Only those start ticked; **Tick the N confident** and **Tick all suggested** tick many at once, and one Preview and one Write pair them all. Change any pick, and untick what you don't agree with.

When the paths aren't enough (a client builds its paths from constants, a gateway has hundreds of routes), **Match with Copilot** starts one Copilot session that reads the repo's call sites against the other box's APIs and proposes which API each call reaches, naming the lines it read. The proposals come back checked and you tick the ones you agree with; they are previewed and written like any pairing, so Copilot proposes and you decide. The session writes only its answer, under `proposals/matching/`. Where `runtime.yaml` doesn't allow copilot-acp, the brief is written there for a Copilot Chat or Claude Code session and **Read the answer** reads the answer back; `atticus connect match <repo> --to <repo> | --system <id>` does the same from a terminal.

**Preview** shows the lines that will be written and what the next `atticus verify <repo> --write` adds, moves and removes. **Write** appends one `link` line per pair to `facts/<repo>.corrections.jsonl`. The call's own fact stays exactly as read. The join reads the link and draws the line, flagged as paired by a person; when a later read renames the API, it is found again by its method and path, and when it is gone, the box says so.

When the repo has an open target question, **All loose calls go there** answers it with `/**`, so calls read later follow it too.

When one side has nothing on record, the panel says so and gives the command: `atticus map --all --gaps --repos <repo>` to read the calls, `atticus map --all --repos <repo>` to read the other repo, or `atticus intake add` for an outside system's spec.

## A repo's owner and system

On a repo's box, **Owner and system…** picks a team from roles.yaml and a system of the profiles. **Preview** shows the lines that change; **Write it** edits the repo's manifest in place, its comments kept. **Add a team…** adds a team roles.yaml doesn't have yet, for review, with nobody on it. **Apply to every repo's map** redraws it (`atticus verify --all --write`), then **Propose for review**.

## Add a box, and declare a link

**Add to the picture…** (above the canvas) lists the manifest's repos not read yet, each with a button to read it with Copilot (when the app can start Copilot) and the command, and adds a new vendor or another team's system to the profile, for review.

On a system's box, **Declare a link…** says what the code can't show: the system publishes to a topic or queue, listens on one, or calls a gateway route (`METHOD /path`). It is written to the profile under the system's `topics` or `calls`, with your name and the date as the line's comment. A declared topic is drawn where a repo of the estate publishes or listens on it with nobody on the other side, dashed and marked declared. A system whose repos are in the manifest needs no declaration: read its code.

## Corrections, and Undo

Every box lists its corrections (a repo's) or declarations (a system's) under **Corrections and declarations**, each with who and when. **Undo** removes exactly the line it wrote; a topic or route written into the profile by hand is changed there, not by Undo. Undoing a pairing doesn't undo a `/**` answer written with it: change that answer on the Questions page. Each change ends with **Apply** (it redraws the map) and **Propose for review**; the `atticus verify` and `git` commands are under **In a terminal** (ADR 0188).

## Decided by AI: correct one, and it spreads

When `runtime.yaml` says `decide: { links: auto, questions: auto }`, Atticus applies what a Copilot session it ran decided, as the AI's and never as yours (ADR 0181). Everywhere such a decision shows, it carries **Detected by AI** in words, with the run it came from linked to Set up › Model runs: the Connect panel (what the AI already paired between the two boxes), Match with Copilot (what it applied, and what it kept for you), Why is this linked?, Corrections and declarations, Questions, Contracts, a change's impact and its knowledge. Counts say how many links and questions were settled from code, by a person and by AI.

**Correct** on any of them opens a form: the right option, the right API with its repo, or none of these. **Apply to similar** is on: **Preview** shows your answer, the rule Atticus derived from it (a path prefix, host or topic pattern, which you can change) and every other item it re-checks: applied, confirmed, replaced, or reverted to open. **Save my correction** writes it as your word. A shape corrected three times offers **Make this a reading rule**, so the next read gets it right at the source.

**Map › Decided by AI** lists what the AI decided that still stands, by repo and kind, and every batch the AI or a correction's rule applied, newest first. **Undo** asks first, then removes exactly the batch's lines and answers, puts back what it took away, and says what it left because it changed since. Map › Trust shows the sample audit's precision for the AI's decisions beside the facts' and links'; below the bar (`decide.minPrecision`), deciding pauses back to proposing and Home says why.

## Readers found / facts say

For a repo with verified facts, the facts are its map, and the built-in readers are a cross-check (ADR 0195). **Map › Trust › Readers found / facts say** (linked from Trust, from each repo on it, and from Set up › Scans) sets the readers' last full read of the repo (`catalog/sources/readers/<repo>.json`) beside what the facts say (the facts snapshot, `catalog/sources/facts/<repo>.jsonl`), record by record, matched by id and then by the kind's key (an endpoint's method and path, a call's caller, method and path, a table's name, a column's `table.column`, a setting's key), never by guesswork:

- **Readers found**: the readers found it and the facts don't have it, with each line they found it on (one item when the code and the OpenAPI file beside it say the same thing).
- **Disagree**: both have it, with a different value: each field and both values.
- **Facts only**: for information; the readers are known to miss things.

Filter by what it is, by kind and by words (a key, an id or a file); the repo and the filter are in the address. Check the cited line, then **Dismiss** what the readers got wrong: it runs `atticus catalog crosscheck <repo> --dismiss <key>` as a step whose lines are in the Console, and keeps the dismissal in `facts/<repo>.crosscheck.yaml` at the readers' value. The item is listed again when the readers' value changes, and **List again** takes a dismissal back. Nothing here changes the catalog. Propose the dismissals file for review like any edit. A repo with no facts yet, no readers slot yet, or only the upgrade's slot (kept from before the upgrade) says so instead. In a terminal, `atticus catalog crosscheck` counts every repo and `atticus catalog crosscheck <repo>` lists its items.

## Catalog builds: confirm, undo, prune

`catalog/generated` is built from each repo's slot and the curated decisions, and nothing is removed or overwritten without being shown first. **Set up › Scans › Catalog builds** shows where each repo's records come from (verified facts, the built-in readers, kept from before the upgrade, or no slot yet), what the next build would do, what the last build here changed (each removal with what explains it), and:

- **A refused build.** When a build would remove more than 10% of a repo's records or 200 in one build, **Review the removals** lists each record with what explains it, and asks you to type the count before **Remove**: the step is `atticus catalog build --allow-removals <count>`, and any other count writes nothing. A scan whose new read would remove that many says the same on Set up › Scans, and its confirm scans again with the count. A removal nothing explains can't be confirmed: it is a bug, and the list is its report.
- **Hand edits.** A file under `catalog/generated` changed by hand is never overwritten. **Make them curated** writes a curated decision for each into `catalog/curated/` (to propose for review) and builds with them; **Discard** asks for the count, and keeps the files' bytes in the undo copy first.
- **Undo.** The last five builds on this machine each keep an undo copy. **Undo to before this…** lists the files it puts back, then puts back `catalog/generated`, `build.json` and the slots as they were (`atticus catalog undo <n> --yes`); an undo can be undone. Git keeps everything older.
- **Prune.** Slot files no build reads (repos no longer in the manifests or archived, and the upgrade's copy of the catalog) are kept until **Remove these** lists and removes exactly them (`atticus catalog prune --yes`).

Each step runs the command as a local job, one at a time with Apply, Propose and Bring in, its lines in the Console. If what a step would change is no longer what the page showed (a scan ran meanwhile, say), it changes nothing and says so: look at the list again.

Set up › Scans shows, after a scan, what it read of each repo: read in full (its readers slot written or unchanged), or kept its last good read, with the commit and why (not cloned here, left out, a failed run, a plugin not used, changes not committed), and whether its facts cite files changed since.

## Working on the canvas

The canvas takes most of the page. Its controls are one bar above it: the lens, where you are, **Add to the picture**, the tools' button, **Keep this arrangement**, **Tidy up** and **Reset** (icons, each named in a tooltip), and at the right the zoom, fit, focus, full screen and Find. The legend (how many links, and how each kind of line is drawn) folds in the canvas's lower left corner, and stays folded in this browser; the details of the box or link you pick are a panel at the canvas's right that **Hide details** closes and **Show details** opens again (it opens by itself when you add, connect, declare or pick a link).

**Layers, filters and tools** (ADR 0175), the bar's tools button, open as a drawer over the canvas's left (Esc or its × closes it); they choose what is drawn and help you find your way, and none of them changes the map.

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
