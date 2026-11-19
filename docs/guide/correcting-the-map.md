# Correcting the map on the canvas

The map is read from code, and sometimes the code can't say where a call goes, who owns a repo, or who publishes to a topic. You can say it on the canvas (Map › Estate). Everything you say is your word: written to a file in the metarepo for review, shown before it is written, drawn dashed and never passed off as read from code. Every change can be undone (ADR 0174).

## Connect two boxes, call by call

Select a repo's box and choose **Connect to…**, or draw a line from the repo's box to another on the canvas. Pick the other box: a repo of the manifest or an outside system.

The box a line starts on is the caller, always. A line from a repo opens Connect. A line from an outside system (a vendor's, another team's: no code in the estate, so no call to pair) to a repo opens **Declare a link…** with the system as the caller and the repo's gateway routes to pick from (see below). A line that connects nothing says why and what to do: a system with several repos is opened first and the line drawn to or from the repo inside; two outside systems are declared from the system's box.

The panel lists this repo's calls that join nothing (asked, no route, left or not joined), with the other box's APIs: a service's entries, a gateway's routes, or an outside system's operations from its intaken spec. For each call the likeliest API is picked already, and the panel says why: the same path (a `/v1` or `/v2` in front doesn't count), the same once the call's setting is filled in from the repo's config (`${refunds.base}/request`), the same but for a prefix or a parameter, what a gateway's route forwards to, the operation's name saying the same as the call site's constant, or names alike (`captureChargePath` and `/partners/northwind/charges/{chargeId}/capture`). Each call's select lists its three likeliest APIs first; with many APIs, a search box narrows the rest.

A pair is **confident** when the best match is sure and well ahead of every other API. Only those start ticked; **Tick the N confident** and **Tick all suggested** tick many at once, and one Preview and one Write pair them all. Change any pick, and untick what you don't agree with.

When the paths aren't enough (a client builds its paths from constants, a gateway has hundreds of routes), **Match with Copilot** starts one Copilot session that reads the repo's call sites against the other box's APIs and proposes which API each call reaches, naming the lines it read. The proposals come back checked and you tick the ones you agree with; they are previewed and written like any pairing, so Copilot proposes and you decide. The session writes only its answer, under `proposals/matching/`. Where `runtime.yaml` doesn't allow copilot-acp, the brief is written there for a Copilot Chat or Claude Code session and **Read the answer** reads the answer back; `atticus connect match <repo> --to <repo> | --system <id>` does the same from a terminal.

**Preview** shows the lines that will be written and what the next `atticus verify <repo> --write` adds, moves and removes. **Write** appends one `link` line per pair to `facts/<repo>.corrections.jsonl`. The call's own fact stays exactly as read. The join reads the link and draws the line, flagged as paired by a person; when a later read renames the API, it is found again by its method and path, and when it is gone, the box says so.

No call is hidden. A call the read ties to something that has no arrow drawn (its own component, or a link deleted on the canvas), or one left outside the estate to a target no box draws, is listed with the loose calls, saying where the read ties it. A call that has an arrow to another box is listed first, to move here (see **It's connected to the wrong box**, below). Whether a call has an arrow is what the built catalog draws (a link deleted on the canvas has none). A call with an arrow to this very box is listed under **Going to <box> already**, with the API it goes to, and can't be paired with that API again; to change which API it goes to, pick its arrow and use **This link is wrong**. **Edit the map**'s **Add a link** from a repo's box offers the same calls, folded under **Move a call here**.

## It's connected to the wrong box

The map draws an arrow from a repo to the wrong box: a question was answered wrongly, the read named the wrong target, the two services serve the same path, or somebody paired it wrongly. Connect the repo to the right box (**Connect to…** on its box, or a line drawn to the right box).

The panel lists the repo's calls that go to another box first, each with where it goes today and how that was decided:

- **read from code**: the call's fact names that box;
- **matched by its address**: its host or base path is that box's, with the host its line writes;
- **matched by its path alone**: nothing names the box, a guess;
- **it goes through a gateway**, whose route forwards it there;
- **an answer to a question**, with who answered and when;
- **paired by** a person, with when and the reason they gave, or **decided by AI**;
- **an arrow kept from an earlier read**: the map still draws it (from before the upgrade, say) and this read doesn't say where the call goes.

The likeliest API of the right box is picked for each call and none is ticked. Tick the calls that really go to the right box, check each API, and choose **Move to <box>**. The preview shows the lines it writes and each arrow that moves; **Move N calls to <box>** writes them, one `link` line per call in `facts/<repo>.corrections.jsonl`, and **Apply** redraws the map: the old arrow goes (or keeps the calls you didn't move) and the new one is drawn, marked as paired by a person. The build says of each arrow it removes that "its call goes to <box> now", and a moved arrow needs no removal confirm.

Your pairing wins over how the call was joined before. Three cases ask something first:

- **The line names the other box** (its host is that box's, or the fact read there names it). The panel says so and asks why; your reason is kept on the pairing's line. The fact stays in the repo's facts as read, verified on its line: a pairing never changes or removes a fact read from code. The right box's panel then says how many pairings go against what the code names. If the code itself is what changed, read the repo again instead.
- **Somebody else paired it**, or the AI did. The panel says who, and you tick **Replace** for it. Your own pairing is replaced without asking.
- **An answer placed it.** The move pairs the calls you tick. The answer stands: the other calls it covers, and new calls that match it, still go to the old box until it is answered again, and the row links **Answer <question> again**.

**Edit the map**'s **Add a link** asks for the same reason before a pair that goes over what the line names is added to your changes. Under **Corrections and declarations**, such a pairing reads "… goes to GET /holds/{id} on forge-ledger, moved by pat from forge-billing over what its line names (billing.forge.example)", with the reason.

**Undo** removes the lines the move wrote. The map is the last Apply's until the next, so the panel says so and offers **Apply**: the arrow is then back where it was. Taking back one pairing is under the removal limits; taking back several at once may be over them, and the Apply then waits for you to confirm the arrows it removes, each listed with why.

The removal guard excuses only the arrow of a call you moved, matched one to one with the arrow that takes its place. Anything else the same Apply removes is listed with its own reason and counts toward the limits, a pairing taken back included (the build can't tell an Undo from a file reverted by hand). A pairing whose call the last read doesn't have is kept and marked "(its call isn't in the last read)" under **Corrections and declarations**.

A call that goes through a gateway can be moved the same way, which says this call doesn't go through that gateway. When it is the gateway that forwards to the wrong service, correct the gateway instead: connect the gateway's box to the right service.

When the right box has no API on record (a repo not read yet, an outside system with no spec), there is nothing to move a call to yet: the panel says so and gives the command that reads it.

When the repo has an open target question, **All loose calls go there** answers it with `/**`, so calls read later follow it too.

When one side has nothing on record, the panel says so and gives the command: `atticus map --all --gaps --repos <repo>` to read the calls, `atticus map --all --repos <repo>` to read the other repo, or `atticus intake add` for an outside system's spec.

## A repo's owner and system

On a repo's box, **Owner and system…** picks a team from roles.yaml and a system of the profiles. **Preview** shows the lines that change; **Write it** edits the repo's manifest in place, its comments kept. **Add a team…** adds a team roles.yaml doesn't have yet, for review, with nobody on it. **Apply to all N repos read** redraws it (`atticus verify --all --write`), then **Propose for review**. It applies every repo read so far, one after another, so on a large estate it takes a while: the Console shows which repo it is on and about how long is left.

## Add a box, and declare a link

**Add to the picture…** (above the canvas) lists the manifest's repos not read yet, each with a button to read it with Copilot (when the app can start Copilot) and the command, and adds a new vendor or another team's system to the profile, for review.

On a system's box, **Declare a link…** says what the code can't show: the system publishes to a topic or queue, listens on one, or calls a gateway route (`METHOD /path`). It is written to the profile under the system's `topics` or `calls`, with your name and the date as the line's comment. A declared topic is drawn where a repo of the estate publishes or listens on it with nobody on the other side, dashed and marked declared. A system whose repos are in the manifest needs no declaration: read its code. A repo the manifest lists with no System of the profiles is drawn in a system of its own id; declaring a link from its box adds that System to the repo's platform profile first, in the same write, and the panel says so before you write it, with who added it and when as its line's comment. **Undo** of its last declaration takes that System away again, unless a person changed it since (its comment holds a short hash of it as added) or a pairing or an answer names it. Where that platform has no profile yet, the panel says which file to add first.

For **Calls a gateway route**, pick the gateway (the repos that have gateway routes), then tick the routes the system calls: each is listed with its method, path, handler and the line it was read from, and there is a search when a gateway has many. Several routes are previewed together and written in one go, one line each. A route declared already is marked and not offered again. A route not read yet can still be typed (`METHOD /path`, or the handler `proxy/flow`). After Apply the arrow is drawn dashed from the system to what the route forwards to (the service behind the gateway), or to the gateway's own box where its forwarding isn't read.

Only a gateway's routes can be declared. For an ordinary service the panel says so ("Declaring who calls an entry of <repo> isn't supported yet"), with what works instead: the gateway in front of it, the line the other way for the repo's own calls, or a topic. A repo whose type only reads like a gateway's (`api-gateway`, say) is told apart: the panel names the manifest to set `type: gateway` in, after which its entries are listed as routes. A system that is on the map only because code names it is added to a profile first (**Add to the picture…**, with the same id).

## Corrections, and Undo

Every box lists its corrections (a repo's) or declarations (a system's) under **Corrections and declarations**, each with who and when. **Undo** removes exactly the line it wrote; a topic or route written into the profile by hand is changed there, not by Undo. Undoing a pairing doesn't undo a `/**` answer written with it: change that answer on the Questions page. Each change ends with **Apply** (it redraws the map) and **Propose for review**; the `atticus verify` and `git` commands are under **In a terminal** (ADR 0188). Above the map, a bar lists the repos whose corrections aren't applied yet. Each has its own **Apply to <repo>'s map**. When several wait, **Apply to the N repos waiting** applies those repos one after another, in name order, and no other repo. Only one Apply runs at a time, so the other buttons wait. **Stop** in the Console ends a run over several repos after the repo being written: that repo's write finishes whole, and the repos not reached keep their own buttons.

## A link a gateway proxy's routing made

**All calls on this arrow are wrong…** corrects every call a caller's line cites, and its button counts only those. A link a gateway proxy's routing made (joined by the route's path or the proxy's BasePath) has no line of a caller's: where it goes is set by the proxy's forwarding, for every caller of the route. When every call on an arrow is such a link, the arrow's panel (and the proxy's box under Links) says so instead of offering a correction, with **Answer where it goes**, which opens the open question about where the proxy forwards that route (asked once per host or path prefix) on Questions, and **Correct the proxy's forwarding**, which opens the forwarding line's facts with **Correct this**. A call's **This link is wrong** on such a link offers the same. Only the forwarding call's own line counts: on a chain of gateways, the last proxy's (the one that reaches the arrow's target); a question citing only the route's entry line or the config that ties it is not offered, and when several are, each button names its path prefix or host. When Atticus finds neither, it says so, and **Or in a terminal** gives `atticus questions` and `atticus verify <proxy-repo> --write`; a proxy whose facts can't be read is said by name, beside the others' actions.

A link with no line of a caller's that no proxy's routing made (a built-in reader's, through no gateway) says just that: there is no call to correct until the caller's repo is read again, with `atticus verify <repo> --write` under **Or in a terminal**.

## Decided by AI: correct one, and it spreads

When `runtime.yaml` says `decide: { links: auto, questions: auto }`, Atticus applies what a Copilot session it ran decided, as the AI's and never as yours (ADR 0181). Everywhere such a decision shows, it carries **Detected by AI** in words, with the run it came from linked to Set up › Model runs: the Connect panel (what the AI already paired between the two boxes), Match with Copilot (what it applied, and what it kept for you), Why is this linked?, Corrections and declarations, Questions, Contracts, a change's impact and its knowledge. Counts say how many links and questions were settled from code, by a person and by AI.

**Correct** on any of them opens a form: the right option, the right API with its repo, or none of these. **Write to similar** is on: **Preview** shows your answer, the rule Atticus derived from it (a path prefix, host or topic pattern, which you can change) and every other item it re-checks: applied, confirmed, replaced, or reverted to open. **Save my correction** writes it as your word. A shape corrected three times offers **Make this a reading rule**, so the next read gets it right at the source.

**Map › Decided by AI** lists what the AI decided that still stands, by repo and kind, and every batch the AI or a correction's rule applied, newest first. **Undo** asks first, then removes exactly the batch's lines and answers, puts back what it took away, and says what it left because it changed since. Map › Read status shows the sample audit's precision for the AI's decisions beside the facts' and links'; below the bar (`decide.minPrecision`), deciding pauses back to proposing and Home says why.

## Cross-check

For a repo with verified facts, the facts are its map, and the built-in readers are a cross-check (ADR 0195). **Map › Read status › Cross-check** (linked from Read status, from each repo on it, and from Set up › Activity › Scans) sets the readers' last full read of the repo (`catalog/sources/readers/<repo>.json`) beside what the facts say (the facts snapshot, `catalog/sources/facts/<repo>.jsonl`), record by record, matched by id and then by the kind's key (an endpoint's method and path, a call's caller, method and path, a table's name, a column's `table.column`, a setting's key), never by guesswork:

- **Readers found**: the readers found it and the facts don't have it, with each line they found it on (one item when the code and the OpenAPI file beside it say the same thing).
- **Disagree**: both have it, with a different value: each field and both values.
- **Facts only**: for information; the readers are known to miss things.

Filter by what it is, by kind and by words (a key, an id or a file); the repo and the filter are in the address. Check the cited line, then **Dismiss** what the readers got wrong: it runs `atticus catalog crosscheck <repo> --dismiss <key>` as a step whose lines are in the Console, and keeps the dismissal in `facts/<repo>.crosscheck.yaml` at the readers' value. The item is listed again when the readers' value changes, and **List again** takes a dismissal back. Nothing here changes the catalog. Propose the dismissals file for review like any edit.

What the readers got right, **Promote to assert…** makes your own fact. It shows the fact first: its kind, the line it cites at the readers' commit with that line's text (when the base clone is at that commit), and what it claims is written there. On **Write it, then verify** it runs `atticus catalog crosscheck <repo> --promote <key>`, which adds the fact to `facts/<repo>.jsonl` with `by: person` and the reader's citation (the facts file's own shape; started from the facts verify last kept when the file isn't there), then `atticus verify <repo>`, which checks the claim on its line like any other fact. The item then says **Your fact: verified on its line**, not verified yet, or rejected with why (kept in `facts/<repo>.rejected.jsonl`). **Apply** (`atticus verify <repo> --write`) puts it in the catalog, after which the readers and the facts agree on it. An endpoint, a call, a setting, a column of a table the facts have, and an event the readers left unresolved can be promoted; anything else says why not, and you dismiss it or ask your assistant to read the repo again. Promoting is a person's word: inside a Copilot session the command is refused. Propose the facts file for review like any edit. A repo with no facts yet, no readers slot yet, or only the upgrade's slot (kept from before the upgrade) says so instead. In a terminal, `atticus catalog crosscheck` counts every repo and `atticus catalog crosscheck <repo>` lists its items.

## Catalog builds: confirm, undo, prune

`catalog/generated` is built from each repo's read and your kept edits, and nothing is removed or overwritten without being shown first. **Set up › Activity › Catalog builds** shows where each repo's records come from (verified facts, the built-in readers, kept from before the upgrade, or no slot yet), what the next build would do, the last build here (whichever command built, a scan, **Apply**, a rename or a build, in the app or a terminal: what it wrote, or why it refused with what it would have removed and the command that goes on; each removal with what explains it, a changed answer named as your own action), and:

- **The upgrade.** A catalog written before beta.27 is shown as not upgraded, with **Upgrade to source slots**: every slot it writes and how many records each adopts, the copy of the catalog kept in `catalog/sources/legacy/generated-before-upgrade/`, and what the first build would change (nothing; else each record file, added, changed or removed). When it changes something, **Accept the changes…** lists them and asks you to type their count first (`--accept-changes <count>`; the catalog as it was stays in the copy). **Review the files it writes…** then lists every file with its size, and asks you to type their count before **Write** (`atticus upgrade --yes`, with `--accept-changes <count>` when there were changes); if what it writes or changes is no longer that list, it writes nothing. A writer refused because the catalog isn't upgraded (or because an undo took the upgrade back) says to run `atticus upgrade --yes` or Upgrade here. When the upgrade's other steps wait, it offers **Run the upgrade** (as Home does) first: they can change what this step writes.

- **A refused build.** When a build would remove more than 10% of a repo's records or 200 in one build, **Review the removals** lists each record with what explains it, and asks you to type the count before **Remove**: the step is `atticus catalog build --allow-removals <count>`, and any other count writes nothing. A scan whose new read would remove that many says the same on Set up › Activity › Scans, and its confirm scans again with the count. A removal nothing explains can't be confirmed: it is a bug, and the list is its report.
- **Hand edits.** A file under `catalog/generated` changed by hand is never overwritten. **Keep my edits** writes your kept edit for each into `catalog/curated/` (to propose for review) and builds with them; **Use Atticus's version…** lists the files, asks for their count, and keeps the files' bytes in the undo copy first.
- **Undo.** The last five builds on this machine each keep an undo copy. **Undo to before this…** lists the files it puts back, then puts back `catalog/generated`, `build.json` and the slots as they were (`atticus catalog undo <n> --yes`); an undo can be undone. Git keeps everything older.
- **Prune.** Slot files no build reads (repos no longer in the manifests or archived, and the upgrade's copy of the catalog) are kept until **Remove these** lists and removes exactly them (`atticus catalog prune --yes`).

Each step runs the command as a local job, one at a time with Apply, Propose and Bring in, its lines in the Console. If what a step would change is no longer what the page showed (a scan ran meanwhile, say), it changes nothing and says so: look at the list again.

Set up › Activity › Scans shows, after a scan, what it read of each repo: read in full (written or unchanged), or kept its last good read, with the commit and why (not cloned here, left out, a failed run, a plugin not used, changes not committed), and whether its facts cite files changed since.

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
