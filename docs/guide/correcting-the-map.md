# Correcting the map on the canvas

The map is read from code, and sometimes the code can't say where a call goes, who owns a repo, or who publishes to a topic. You can say it on the canvas (Map › Estate). Everything you say is your word: written to a file in the metarepo for review, shown before it is written, drawn dashed and never passed off as read from code. Every change can be undone (ADR 0174).

## Connect A to B

Every box on the canvas (a repo, a component, a system, an outside system) has one button, **Connect to…**. Pick the other box, or draw a line from one box to the other: the same panel opens either way (ADR 0204).

**The direction is yours.** The panel's first line is two radios, "<A> calls <B>" and "<B> calls <A>". A line's start is the caller, and from the button the box you picked; only your click changes it, and the title says "Connect <caller> to <callee>".

**Atticus says how it connects**, in the panel's second line:

- **The calls the code shows.** "Atticus found N calls in <A>'s code that look like they go to <B>. The K it is sure of are ticked." The calls that go to another box today are listed first (see **It's connected to the wrong box**, below), then those with no arrow. Each row says where the call stands in one of four words (no arrow yet, goes to <box>, goes here already, connected by <name>) and why it was left in one of four (its address isn't known, nothing on the map serves it, Atticus can't match this kind, you said it calls nothing here), the exact status and reason beside it. **None of these: declare the arrow instead** is under the rows.
- **Connected already.** "<A> already calls <B>: N calls read from code. There is nothing to add." with **Show the arrow**.
- **Declared already.** "<name> declared this arrow on <date>: "<why>"." with **Remove it**.
- **Declare the arrow.** Where no call of the caller could be the callee's (the caller has no code on record, either box is an outside system, a planned system, or not read): "Atticus found no call in <A>'s code that goes to <B>. You can still draw the arrow: it will be your word, drawn dashed and marked "declared by <name>"."
- **Something is missing first**, said in the panel with the control that fixes it: a system that holds several repos ("Which one?", its repos to pick), a system with no repo yet (declare the arrow to the system itself, **Not built yet** ticked, or **Add its repo…**), a repo not read or not checked yet (**Read <B> now**, **Check <B>'s facts now**; you can declare the arrow beside it, and the code retires it later), a system only the code names (say whether it is another team's or a vendor's, then **Add <system> and continue**: the system is added to the profile in the same write as the arrow, both shown in the preview, and Undo takes both away while the system is still as added). For an outside system calling a gateway, **Say which routes (optional)** lists the gateway's routes: tick the routes it calls and each is declared as a route instead of the arrow; tick none for the arrow.

### Declare an arrow

Say why it is so (required, 3 to 500 characters: "The proxy's target is set at deploy time; the platform team confirmed it."), tick **Not built yet** for a box that isn't built, and choose **Connect: declare the arrow**. One button does it all: it previews the lines, writes one item of the `links` list in the caller's platform's `profile.yaml` (the callee's, when the caller has none), and builds the catalog once, then says "Connected: <A> → <B> is on the map." with **Show the arrow**, **Undo** and **Propose for review**. What was written is under **What was written**. The profile moves to version 3 for it, the number only; every other line stays as you wrote it.

On the map a declared arrow is a dashed line in the declared layer, labelled "declared by <name>". Pick it and its panel says "<name> declared on <date> that <A> calls <B>: "<why>". No code was read for this arrow.", with **Remove it** (the lines first, then the item out and the map built). **Edit the map**'s Delete of a declared arrow takes its item out of the profile too, never a kept edit beside it. **Show the arrow** selects it on the map. It is an asserted Interface flagged `declared-link` whose only evidence is your word: it cites no line, is never verified, carries no call onward (no flow, no gateway chain) and is never counted with links read from code. An arrow the code already shows can't be declared: the panel says so with the `connected` words.

**When the code later shows the call** (a read finds it, or a person pairs it), the declared arrow stops being drawn at once: there is one arrow, the code's. The build's report lists it, and wherever the arrow or either box is open the page says "The code now shows <A> calling <B> (N calls). The arrow <name> declared on <date> is no longer needed." with **Retire the declared arrow**: it shows the lines it takes out of the profile, then removes exactly that item and builds the map (a build that would also remove something else waits for your confirm). Above the map, "N declared arrows the code now shows" lists each, opening its panel; Your changes on either box says it too. Nothing in the profile changes until you do; if the call goes away again first, the declared arrow is drawn again. A call the other way retires nothing. An arrow to a repo or system the manifests and profiles no longer have is reported by the build and kept.

**Local and shared.** The button writes in this metarepo's working tree only (the profile or corrections file, `catalog/generated`, `build.json` and the build's undo copy): no commit, no push, no network. Until you choose **Propose for review** (a branch, a commit, a push and a pull request a human approves) the panel says "Not proposed yet: only this machine has it." An older Atticus refuses a version-3 profile, so the team upgrades before it merges the first declared arrow.

**Undo** takes back exactly what the button wrote, while it is still as written, and builds once; when the arrow or the lines changed since, it says what changed and removes nothing (undo it under **Your changes** then).

### Find it in the code

A declared arrow says where to look; it is never evidence. **Find it in the code**, on a declared arrow's panel (or `atticus connect find <repo> --to <repo> | --system <id>` in a terminal), has your assistant read the caller's code for the call:

- Atticus writes a brief, `facts/<repo>.find.md`, from the arrow: who declared it and why (fenced as data, never an instruction), what the map knows of the callee (its entries, hosts and base path, topics, the gateway routes that forward to it, the settings and deploy tokens other repos reach it by; at most 200 of each, nearest to the caller's calls with no arrow first), and where to look in the caller (its calls with no arrow and why each was left, its config, deployment, pipeline and proxy target files, then the files no fact cites). Its rule: write a call only where a line shows it; never write a fact because the arrow says there is one.
- Where the app can start the assistant, it is one unattended session; else the panel says what to paste into Copilot Chat or Claude Code, and **Read the answer** goes on (`--read` in a terminal). The session writes ordinary facts (file, line, value, quote) and one answer, `proposals/find/<repo>--<box>.yaml` (`looked`, `found`, `elsewhere`, `none`). Atticus checks the answer (an id that is no call fact of the repo, or a file it doesn't have, is left out and listed), then `atticus verify <repo> --write` checks every fact on its line and builds.
- **The outcome is told from the catalog after the build**, never from what the session says:
  - **found**: a real call goes the same way. The code's arrow is drawn, the declared one isn't, and the arrow reads "confirmed by code on <date>", with **Retire the declared arrow**.
  - **found-loose**: the call is read but its address is set outside the code (a setting, a deploy token), so the code doesn't say where it goes: "Atticus found the call at <file:line>…", with **Connect these N calls to <box>**, today's pairing of them.
  - **elsewhere**: the code shows the call going to another box. Both arrows are drawn until you choose **Keep both**, **Move this call to <box>** or **Retire the declared arrow**.
  - **not-found**: "Read on <date>: no code found for it. Atticus looked at N files.", with the files and any fact the verifier rejected, and why. The button then reads **Find it again** when the clone has moved past the read or a reading rule became active since, else **Read again anyway**.
- The outcome is kept in `facts/<repo>.find.yaml`, one entry per callee, proposed with the facts. A find never changes the profile.
- **Make this a reading rule**, after a found call, drafts a rule from its line (`org-pack/reading-rules/types/<type>.yaml`, "from a declared arrow the code confirmed"), given to no read until a person sets it active (`atticus rules activate`).

### Pair the calls

For the calls the code shows, the panel lists the caller's calls with the other box's APIs: a service's entries, a gateway's routes, or an outside system's operations from its intaken spec. For each call the likeliest API is picked already, and the panel says why: the same path (a `/v1` or `/v2` in front doesn't count), the same once the call's setting is filled in from the repo's config (`${refunds.base}/request`), the same but for a prefix or a parameter, what a gateway's route forwards to, the operation's name saying the same as the call site's constant, or names alike (`captureChargePath` and `/partners/northwind/charges/{chargeId}/capture`). Each call's select lists its three likeliest APIs first; with many APIs, a search box narrows the rest.

A pair is **confident** when the best match is sure and well ahead of every other API. Only those start ticked; **Tick the N confident** and **Tick all suggested** tick many at once, and one Preview and one Write pair them all. Change any pick, and untick what you don't agree with.

When the paths aren't enough (a client builds its paths from constants, a gateway has hundreds of routes), **Match with Copilot** starts one Copilot session that reads the repo's call sites against the other box's APIs and proposes which API each call reaches, naming the lines it read. The proposals come back checked and you tick the ones you agree with; they are previewed and written like any pairing, so Copilot proposes and you decide. The session writes only its answer, under `proposals/matching/`. Where `runtime.yaml` doesn't allow copilot-acp, the brief is written there for a Copilot Chat or Claude Code session and **Read the answer** reads the answer back; `atticus connect match <repo> --to <repo> | --system <id>` does the same from a terminal.

**Preview** shows the lines that will be written and what the map gains, moves and loses. The confirm writes one `link` line per pair to `facts/<repo>.corrections.jsonl` and builds the catalog in the same job (no Apply to press after it), then says "Connected: <repo> → <box> is on the map." with **Undo** (exactly those lines, then one build, which waits for your confirm when what it removes is over the limits) and **Propose for review**. **All N calls with no arrow go there** answers a question too, so it is written alone and applied with **Apply**, as before. The call's own fact stays exactly as read. The join reads the link and draws the line, flagged as paired by a person; when a later read renames the API, it is found again by its method and path, and when it is gone, the box says so.

No call is hidden. A call the read ties to something that has no arrow drawn (its own component, or a link deleted on the Map), or one left outside the estate to a target no box draws, is listed with the calls with no arrow, saying where the read ties it. A call that has an arrow to another box is listed first, to move here (see **It's connected to the wrong box**, below). Whether a call has an arrow is what the built catalog draws (a link deleted on the Map has none). A call with an arrow to this very box is listed under **Going to <box> already**, with the API it goes to, and can't be paired with that API again; to change which API it goes to, pick its arrow and use **This link is wrong**. **Edit the map**'s **Add a link** from a repo's box offers the same calls, folded under **Move a call here**.

For an outside system as the caller, **Details** keeps what **Declare a link…** did: the topics it publishes or listens on, and the gateway routes it calls (see below).

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

**Edit the map**'s **Add a link** asks for the same reason before a pair that goes over what the line names is added to your changes. Under **Your changes**, such a pairing reads "… goes to GET /holds/{id} on forge-ledger, moved by pat from forge-billing over what its line names (billing.forge.example)", with the reason.

**Undo** removes the lines the move wrote. The map is the last Apply's until the next, so the panel says so and offers **Apply**: the arrow is then back where it was. A pairing taken back counts toward the removal limits: when the arrows it removes are more than a tenth of a repo's records (a small repo's three of 13, say), the build waits for you to confirm them on **Catalog builds**, each listed with why.

The removal guard excuses only the arrow of a call you moved, matched one to one with the arrow that takes its place, and the loose ends your pairings join, in whichever build draws the pairing ([ADR 0195's addendum of 2026-11-19](../adr/0195-the-catalog-is-built-from-source-slots.md#addendum-a-persons-pairing-and-the-removal-limits-release-200-beta30-accepted-by-the-owner-2026-11-19)). Anything else the same Apply removes is listed with its own reason and counts toward the limits, a pairing taken back included (the build can't tell an Undo from a file reverted by hand), unless an older pairing of the same call to another box is in force again: the arrow going back there is a move. A pairing whose call the last read doesn't have is kept and marked "(its call isn't in the last read)" under **Your changes**.

A call that goes through a gateway can be moved the same way, which says this call doesn't go through that gateway. When it is the gateway that forwards to the wrong service, correct the gateway instead: connect the gateway's box to the right service.

When the right box has no API on record (a repo not read yet, an outside system with no spec), there is nothing to move a call to yet: the panel says so and gives the command that reads it.

When the repo has an open target question, **All N calls with no arrow go there** answers it with `/**`, so calls read later follow it too.

When one side has nothing on record, the panel says so and gives the command: `atticus map --all --gaps --repos <repo>` to read the calls, `atticus map --all --repos <repo>` to read the other repo, or `atticus intake add` for an outside system's spec.

## A repo's owner and system

On a repo's box, **Owner and system…** picks a team from roles.yaml and a system of the profiles. **Preview** shows the lines that change; **Write it** edits the repo's manifest in place, its comments kept. **Add a team…** adds a team roles.yaml doesn't have yet, for review, with nobody on it. **Apply to all N repos read** redraws it (`atticus verify --all --write`), then **Propose for review**. It applies every repo read so far, one after another, so on a large estate it takes a while: the Console shows which repo it is on and about how long is left.

## Add a box, and declare a link

**Add to the map…** (above the canvas) lists the manifest's repos not read yet, each with a button to read it with Copilot (when the app can start Copilot) and the command, and adds a new vendor or another team's system to the profile, for review.

Under **Details** of an outside system's **Connect to…** panel, **Declare a link…** says what the code can't show: the system publishes to a topic or queue, listens on one, or calls a gateway route (`METHOD /path`). It is written to the profile under the system's `topics` or `calls`, with your name and the date as the line's comment. A declared topic is drawn where a repo of the estate publishes or listens on it with nobody on the other side, dashed and marked declared. A system whose repos are in the manifest needs no declaration: read its code. A repo the manifest lists with no System of the profiles is drawn in a system of its own id; declaring a link from its box adds that System to the repo's platform profile first, in the same write, and the panel says so before you write it, with who added it and when as its line's comment. **Undo** of its last declaration takes that System away again, unless a person changed it since (its comment holds a short hash of it as added) or a pairing or an answer names it. Where that platform has no profile yet, the panel says which file to add first.

For **Calls a gateway route**, pick the gateway (the repos that have gateway routes), then tick the routes the system calls: each is listed with its method, path, handler and the line it was read from, and there is a search when a gateway has many. Several routes are previewed together and written in one go, one line each. A route declared already is marked and not offered again. A route not read yet can still be typed (`METHOD /path`, or the handler `proxy/flow`). After Apply the arrow is drawn dashed from the system to what the route forwards to (the service behind the gateway), or to the gateway's own box where its forwarding isn't read.

Only a gateway's routes can be declared as routes. For an ordinary service, declare the arrow instead (**Connect A to B**, above). A repo whose type only reads like a gateway's (`api-gateway`, say) is told apart: the panel names the manifest to set `type: gateway` in, after which its entries are listed as routes. A system that is on the map only because code names it is added to a profile first (**Add to the map…**, with the same id).

## Corrections, and Undo

Every box lists its corrections (a repo's) or declarations (a system's) under **Your changes**, each with who and when, and the declared arrows at either end of it, each with **Remove it**. **Undo** removes exactly the line it wrote; a topic or route written into the profile by hand is changed there, not by Undo. Undoing a pairing doesn't undo a `/**` answer written with it: change that answer on the Questions page. Each change ends with **Apply** (it redraws the map) and **Propose for review**; the `atticus verify` and `git` commands are under **In a terminal** (ADR 0188). Above the map, a bar lists the repos whose corrections aren't applied yet. Each has its own **Apply to <repo>'s map**. When several wait, **Apply to the N repos waiting** applies those repos one after another, in name order, and no other repo. Only one Apply runs at a time, so the other buttons wait. **Stop** in the Console ends a run over several repos after the repo being written: that repo's write finishes whole, and the repos not reached keep their own buttons.

## A link a gateway proxy's routing made

**All calls on this arrow are wrong…** corrects every call a caller's line cites, and its button counts only those. A link a gateway proxy's routing made (joined by the route's path or the proxy's BasePath) has no line of a caller's: where it goes is set by the proxy's forwarding, for every caller of the route. When every call on an arrow is such a link, the arrow's panel (and the proxy's box under Links) says so instead of offering a correction, with **Answer where it goes**, which opens the open question about where the proxy forwards that route (asked once per host or path prefix) on Questions, and **Correct the proxy's forwarding**, which opens the forwarding line's facts with **Correct this**. A call's **This link is wrong** on such a link offers the same. Only the forwarding call's own line counts: on a chain of gateways, the last proxy's (the one that reaches the arrow's target); a question citing only the route's entry line or the config that ties it is not offered, and when several are, each button names its path prefix or host. When Atticus finds neither, it says so, and **Or in a terminal** gives `atticus questions` and `atticus verify <proxy-repo> --write`; a proxy whose facts can't be read is said by name, beside the others' actions.

A link with no line of a caller's that no proxy's routing made (a built-in reader's, through no gateway) says just that: there is no call to correct until the caller's repo is read again, with `atticus verify <repo> --write` under **Or in a terminal**.

## Decided by AI: correct one, and it spreads

When `runtime.yaml` says `decide: { links: auto, questions: auto }`, Atticus applies what a Copilot session it ran decided, as the AI's and never as yours (ADR 0181). Everywhere such a decision shows, it carries **Detected by AI** in words, with the run it came from linked to Set up › Activity › Model runs: the Connect panel (what the AI already paired between the two boxes), Match with Copilot (what it applied, and what it kept for you), Why is this linked?, Your changes, Questions, Contracts, a change's impact and its knowledge. Counts say how many links and questions were settled from code, by a person and by AI.

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

`catalog/generated` is built from each repo's read and your changes, and nothing is removed or overwritten without being shown first. **Set up › Activity › Catalog builds** shows where each repo's records come from (verified facts, the built-in readers, kept from before the upgrade, or no stored read yet), what the next build would do, the last build here (whichever command built, a scan, **Apply**, a rename or a build, in the app or a terminal: what it wrote, or why it refused with what it would have removed and the command that goes on; each removal with what explains it, a changed answer named as your own action), and:

- **The upgrade.** A catalog written before beta.27 is shown as not upgraded, with **Upgrade to stored reads**: every stored read it writes and how many records each takes, the copy of the catalog kept in `catalog/sources/legacy/generated-before-upgrade/`, and what the first build would change (nothing; else each record file, added, changed or removed). When it changes something, **Accept the changes…** lists them and asks you to type their count first (`--accept-changes <count>`; the catalog as it was stays in the copy). **Review the files it writes…** then lists every file with its size, and asks you to type their count before **Write** (`atticus upgrade --yes`, with `--accept-changes <count>` when there were changes); if what it writes or changes is no longer that list, it writes nothing. A writer refused because the catalog isn't upgraded (or because an undo took the upgrade back) says to run `atticus upgrade --yes` or Upgrade here. When the upgrade's other steps wait, it offers **Run the upgrade** (as Home does) first: they can change what this step writes.

- **A refused build.** When a build would remove more than 10% of a repo's records or 200 in one build, **Review the removals** lists each record with what explains it, and asks you to type the count before **Remove**: the step is `atticus catalog build --allow-removals <count>`, and any other count writes nothing. A scan whose new read would remove that many says the same on Set up › Activity › Scans, and its confirm scans again with the count. A removal nothing explains can't be confirmed: it is a bug, and the list is its report.
- **Hand edits.** A file under `catalog/generated` changed by hand is never overwritten. **Keep my edits** writes your kept edit for each into `catalog/curated/` (to propose for review) and builds with them; **Use Atticus's version…** lists the files, asks for their count, and keeps the files' bytes in the undo copy first.
- **Undo.** The last five builds on this machine each keep an undo copy. **Undo to before this…** lists the files it puts back, then puts back `catalog/generated`, `build.json` and the slots as they were (`atticus catalog undo <n> --yes`); an undo can be undone. Git keeps everything older.
- **Prune.** Slot files no build reads (repos no longer in the manifests or archived, and the upgrade's copy of the catalog) are kept until **Remove these** lists and removes exactly them (`atticus catalog prune --yes`).

Each step runs the command as a local job, one at a time with Apply, Propose and Bring in, its lines in the Console. If what a step would change is no longer what the page showed (a scan ran meanwhile, say), it changes nothing and says so: look at the list again.

Set up › Activity › Scans shows, after a scan, what it read of each repo: read in full (written or unchanged), or kept its last good read, with the commit and why (not cloned here, left out, a failed run, a plugin not used, changes not committed), and whether its facts cite files changed since.

## Working on the canvas

The canvas takes most of the page. Its controls are one bar above it: the lens, where you are, **Add to the map**, the tools' button, **Keep this arrangement**, **Tidy up** and **Reset** (icons, each named in a tooltip), and at the right the zoom, fit, focus, full screen and Find. The legend (how many links, and how each kind of line is drawn) folds in the canvas's lower left corner, and stays folded in this browser; the details of the box or link you pick are a panel at the canvas's right that **Hide details** closes and **Show details** opens again (it opens by itself when you add, connect, declare or pick a link).

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
