# Changelog

All notable changes to Atticus. Versions follow [Semantic Versioning](https://semver.org); contracts C1 to C6 change only with an ADR, a schema version and a migration (`atticus upgrade`).

## Unreleased

### A starter review every metarepo gets (ADR 0119)

- `atticus init` and `atticus adopt` write `org-pack/checklists/review.yaml`: ten AI rules for the critic's business, architecture, story and delivery lenses, each a plain-words prompt that judges a draft's meaning against the estate and the brief and quotes the line it cites. Define: every outcome is placed; a flow the change alters isn't marked only read; a capability the brief assumes that nothing in the estate does is named as a gap. Design: every outcome has its target-flow steps; data a step returns or shows comes from somewhere; a new column has its classification and migration; each hop's pattern fits it. Plan: each outcome has a story; criteria are testable and name their data; requests are raised in time. With the default gates and change types, a new metarepo's drafts are now reviewed by a model, with Copilot too.
- It is the organisation's configuration, not the constitution: change, waive, retire or delete its rules, or delete the file to turn it off. `init --from <pack>` doesn't add it.
- `atticus upgrade` adds it once to a metarepo whose org pack has no AI review of its own, with the checklists README beside it, backed up first; it leaves a `review.yaml` or any checklist with an AI rule alone, and doesn't add it back once deleted.
- In a stage's review, the change's brief now goes to every lens with the draft, so a lens whose rules read other artifacts (the story lens) still judges against the brief.

### What a live run with Copilot found (ADR 0111 addendum)

- The fast path and the architecture stage check that every field a plan returns comes from somewhere, that a write stores what it sends, and that a read or write names its table under `store`; a column in other casing, a classification outside the org pack's levels and a misnamed Flyway migration are handed back.
- A citation of a data block (`atticus-data:brief.md:5`) is read as that block's file: the block's id is Atticus's own. Mistakes about meaning are handed back with hints the catalog gives (the flow an endpoint starts, the nearest entries, the `store` form), never rewritten.
- Questions: one that cites no file and line isn't asked; reference errors are the draft's to fix, not a person's; a column's classification is asked plainly with the org pack's levels as choices; every question is filed under its own repo.
- A stage run again while its hand-off waits offers the same run again; one whose run is gone drafts again; one whose answer was checked but never read in reads it in.
- The task context puts a new migration in the folder the store's migrations are in; an estimate of one unit says "1 unit of work".

### The critic's AI lenses review every draft, with Copilot too (ADR 0115)

- In hand-off mode (Copilot in VS Code, `--handoff`), `atticus change feature`, `change architecture`, `change small` and `plan stories` now hand off the critic's AI lenses after a draft passes the rules, one at a time: the step ends on the lens's run, and after `atticus handoff done` its resume offers the next lens. When every lens is in, their blocking findings go back with the next draft, as the rules' findings do, and their knowledge gaps become questions. Before, the lenses were recorded as not run and left to `/atticus-critic`.
- Each lens now reviews the stage's draft (`feature.md`, `feature.yaml`, the target flows and the artifacts the stage writes) with the estate the drafter read, against the brief, including what the draft left out. It may cite the draft's lines. The lens's prompt says so.
- Which lenses run comes from the org pack, as before: the gate's checklists, the change type's lenses and each rule's artifacts. AI off keeps them off. A draft with a blocking finding of its own goes back first, without lenses.
- `--handoff --json` adds `lens` to a lens's hand-off. The VS Code runner doesn't count a lens's first offer toward its limit of eight hand-offs, but a lens offered again counts.
- `round.yaml` records each lens that ran, with the draft files it read under `artifacts`.

### Prompt history (ADR 0110)

- What people type to their assistant in a metarepo and what it answers, kept beside the model runs: one record per prompt and per response in `.atticus/history/<yyyy-mm>.jsonl`, on this machine only (`history/` joins `.atticus/.gitignore`; `atticus upgrade` adds it to an older metarepo). Each record has its id, time, surface (`claude-code`, `vscode` or `cli`), session, kind, text, size, its slash command, and the change it is about when that can be told exactly (the one change its text names, else the branch `change/<id>`). Text is cut at 64 KB and marked; what matches the log's secret patterns is masked and the record marked. Text is data, never instructions.
- `atticus history add --surface <s> --kind prompt|response [--session id] [--command c]` records one, reading the text from stdin; `atticus history [--change id] [--session id] [--filter words] [--limit n] [--json]` lists the turns (each prompt with its response) by session, newest first; `atticus history show <id> [--json]` prints one and its pair; `atticus history off` and `history on` stop and start recording on this machine (`.atticus/me.yaml`). The org pack turns it off for everyone with `history: { record: false }` in `runtime.yaml` (optional; no schema version bump).
- The Claude Code plugin: `UserPromptSubmit` and `Stop` hooks record each prompt and each reply (the transcript's last assistant message) in a metarepo, printing nothing; the read-only MCP tool `prompt_history`.
- The VS Code extension records every `@atticus` request and the reply it streamed through `atticus history add`, a session per chat; **Atticus: Open the prompt history** opens the screen. Copilot's other chats can't be recorded: VS Code gives extensions no access to them.
- The app: a **Prompt history** screen (More, Run, `#/history`), the turns grouped by session, each prompt beside its response in a box of its own, with a filter box, a change filter and whether recording is on. The IntelliJ plugin's **Atticus: Prompt History** action opens it (Copilot in IntelliJ gives plugins no chat, so nothing typed there is recorded).
- The local API: `GET /api/history` (`?change=`, `?session=`, `?q=`, `?limit=`) and `GET /api/history/{id}`. API 2.10.0.

### Checks that tie each value to its source (ADR 0111)

- The knowledge scan and `atticus knowledge find` check each lead time, date, owner and status against the item's quotes (numbers folded from words, "five" is 5; units exact), and each number a rule states against its page; a value no quote states goes back to the assistant, which quotes its line under `also_on`. The bench reference quotes its three lead times so.
- `atticus change needs`: a need's quote has at least 12 letters and a word that isn't a stop word, and when it is needed comes from the item's lead time (20 working days or more before design, 5 or more before build, less before release), not the assistant's word.
- Scan settings: an exclude cites a file in the folder or a line that names it, and can't leave out more than half the code or the main source folder unless a build or config file leaves it out itself; a prefix is the value on its line (or its URL's path or placeholder default); `atticus scan survey` hands back an empty answer for a repo with entry points or calls unless it says why under `nothing_to_set` with the lines it read.
- `atticus change architecture`: a call's entry must be one of the callee's endpoints (or `new: true`, and then not one of them), a new table must not be in the catalog, and a read names columns the table has. Each target flow records the version of today's flow it was written against (flow delta schemaVersion 2; version 1 files read and are flagged as not pinned), so a spec drafted again shows "today's flow changed since this target was written" instead of re-targeting steps by number.
- The critic keeps an evidence entry only with a quote of at least 12 characters on the line it cites (or on just one line of the file); a line number alone no longer counts.

### Every prompt fits the model it goes to (ADR 0112)

- `--max-tokens n` on every AI step (scan survey and verify, spec draft, knowledge scan, find and ask, change feature, architecture, draft and needs, plan stories, critic): the whole prompt fits n tokens, counted as characters / 4 with a quarter kept back for the count's error and 400 tokens for the hand-off's frame (8,658 of GPT-4o mini's 12,078). The context engine's steps take that room as their budget; the others cut their lowest-priority sources to it. A knowledge scan given only the limit sizes its batches from it.
- A step whose smallest useful prompt (its instructions and what it can't do without) can't fit says so before handing off, with the numbers and what to do: a model with a bigger limit, or, for the knowledge scan, fewer pages at a time.
- The VS Code extension passes its model's limit to every step, not only the knowledge scan, and every round keeps it. The app's server passes the configured model's limit to each step it starts when `runtime.yaml` gives one (`adapters.model.settings.maxInput`, a new optional setting).
- Spec draft and scan verify send code as numbered excerpts, 20 lines either side of each cited line, merged where they overlap and ranked by how many facts cite them; spec draft keeps the cited code ahead of other repos' entry points.
- Scan verify gets the code around each record and must cite each confirmation: the record, the line that shows it in the file it was read from, and a quote of at least 8 characters found there that names its path, method or table. An uncited confirmation (including a bare id) is handed back and never pinned as verified.

### Small changes fast, files into a change, and the task's context (ADR 0113)

- The fast path: `change-types.yaml` version 2 (C6) lets a change type be `size: small`, a standard type let its brief say `Size: small` (`smallWhenBriefSays`), and name the gate its critic runs at (`fastGate`). `atticus upgrade` moves a version 1 file (`change-types-v2`), every type still standard. The built-in types gain `small-change` (plan, build, release) with its own brief template; `config-change` and `tech-debt` let a brief say small.
- `atticus change small <change>` (and `/atticus-small`, `--handoff`, the VS Code runner, `@atticus /small`): one AI step from brief to tasks. The assistant places the change, writes its target flows and words its stories in one answer; Atticus runs the feature, architecture and stories checks on it, derives the tasks from the target flows, runs the critic at the type's gate on every draft and writes every file the full path writes, plus the proposal while it is still the template. `atticus next`, the app's Run next and the stage pages name it for a small change.
- `atticus change attach <change> <files...>`: specs, screenshots, PDFs, email exports and documents copied into the change's `inputs/`, listed with who and when in `inputs/index.yaml`, a duplicate refused, a newer version kept beside the older, each screened for hidden instructions and read by intake's readers into `inputs/read/` with every line or page cited. The feature, architecture and fast-path steps and the task context read them as data; the context engine indexes them.
- The local API's `GET` and `POST /api/changes/{id}/inputs` (API 2.10.0; the upload in base64, up to 15 MB, guarded like every write) and `fastPath` on a change; the app's Files attached with **Attach a file** on a change's page and the Feature page; VS Code's **Attach to Atticus change** (Explorer, sidebar, palette); IntelliJ's **Attach to Atticus Change…** (Project view, editor tab); `/atticus-attach` for Copilot and Claude Code.
- `atticus task context <change> <task> [--json|--markdown]`: a task's story and criteria, the target-flow step with today's step and the file and line it is cited at, today's flow, the needs, standards and decisions that apply, the files attached and the files likely to change. The `task_context` MCP tool reads it; `/atticus-task <change> <task>` loads it in Copilot's agent mode or Claude Code; VS Code's **Start this task in Copilot** opens Copilot Chat in agent mode with it; IntelliJ's **Atticus: Start a Task in Copilot** puts it on the clipboard; `atticus task run` puts it in its pack.

### The context engine (ADR 0107)

- The index holds knowledge items, flows and their steps, changes (brief, placement, needs, target flows), answered questions, wiki sections and the profile's systems, with typed links that record how each was made; it updates per file and rebuilds an old index once.
- `atticus query "<words>" --search` and the `search` MCP tool search everything the index holds, names and ids above prose.
- `change needs`, `change feature`, `change architecture` and `plan stories` send the context the change leads to, fitted to the budget, and say what they left out; `--context-tokens n` sets the room, `--whole-context` sends the whole lists as before. The eval (`docs/evidence/context-eval.md`) scores each step with and without the engine; under a tight budget the whole lists lose what the engine keeps.
- The model asks for more (ADR 0107 addendum): read-only context tools beside a step's pack (`search`, `show`, `walk`, `show_code`), defined once in `@maycombhq/index` and run against the index and the workspace checkout (`show_code` shows a few lines at each line a fact cites, never outside a repo's clone). The model runtime offers them through the Anthropic, OpenAI-compatible, Azure OpenAI and Bedrock tool-call APIs; the VS Code extension through Copilot's language model tools, each call run as `atticus context call --run <run>`; Claude Code through the new `show`, `walk` and `show_code` MCP tools. At most 6 rounds of calls and 12,000 tokens from tools in a run (3,000 a call); the run record says when a cap stopped them.
- `atticus context show|walk|code|tools|call` run the same tools from the command line.
- The run record is at version 2 (C5): it keeps the tools offered, every call and what it returned, and the cap that stopped them; a version 1 record still reads. Model-runtime runs are kept under `.runs/` too. `atticus runs show`, `GET /api/runs/{runId}/transcript` (`tools`, API 2.10.0) and the app's Model runs screen show what the model looked up.
- Gaps (ADR 0107 point 5): `change needs`, `change feature`, `change architecture` and `plan stories` list the names the change uses that nothing Atticus has read says anything about, tell the model not to guess, and turn each gap the answer relies on into a question to a person (one per gap and change, whichever step meets it first). An answered gap is indexed as asserted knowledge, the name is known from then on, and the answer goes in the change's later packs. Fewer false gaps: capitalised words in headings, Title Case lines, Given/When/Then, days and months, fields, files and commands in backticks, a known name with a generic word after it (Northwind Pay API) and a phrase a wiki or record already uses are not gaps.
- The context eval runs each step a third way, with the engine and the tools a scripted model calls: at the tight budget the tools bring back what the pack left out (needs: recall 0.50 to 1.00), at more tokens in all, so packs don't start smaller yet.

### A change drawn from its target flows (ADR 0108)

- `atticus change map <change> [--format mermaid|drawio] [--json]`, `GET /api/changes/{id}/map` (API 2.9.0), the app's Change diagram (More, Design), `@atticus /changemap` in VS Code (drawn in Copilot Chat as Mermaid), IntelliJ's Atticus: Change Diagram and the `change_map` MCP tool: the components, entries and tables a change touches, marked + new, ◇ changed or ✕ retired from the target flows' own marks, the rest as context. A part the catalog lacks is unknown, never new by that alone; a step sent elsewhere draws today's line retired and the new one added. The legend reads + New, ◇ Modify, ✕ Retire in every view.

### Estimates (ADR 0109)

- A change's estimate: its size counted from its target flows, each changed step a class of work, the org pack's ranges (new optional `estimates.yaml`, with who agreed them) summed by a seeded simulation, the drivers named with their sources, the calendar beside the release forecast's waiting, and never a number nobody stands behind; a unit no class matches says it needs one. `atticus change estimate <change> [--json]`, `GET /api/changes/{id}/estimate` (API 2.10.0), the app's Estimate (More, Plan; linked from the Architecture stage), `@atticus /estimate` and Open a change's estimate in VS Code, IntelliJ's Atticus: Estimate, and the `change_estimate` MCP tool. It says it isn't calibrated: past changes don't record their effort yet.

### Does the code do what the design says? (ADR 0114)

- `atticus change conform <change> [--repo r] [--ref branch] [--task t] [--latest] [--json]`: each repo's branch (the change branch, a task's branch, or `--ref`) is scanned at its commit and at its base, from a detached worktree of the base clone with the scan cache (nobody's working copy is touched), and checked against the change's target flows: every call a step adds is an Interface from the flow's component, every table, column and migration a step names exists, a new flow's endpoint exists, every call a step removes is gone; what the branch adds that no target flow names (a call, publish, endpoint, table or column) is out of scope. Every item cites its file and line in the new code, or the target-flow file and step for what is missing. No AI; planned (Spec Kit) records never count as code.
- Missing and still-there items are blocking findings, out-of-scope items risks, on a new built-in `conform` gate that holds back the Build hand-off like drift, hand-up and trace; a person dismisses one as not relevant, and the dismissal survives the next check. Each repo's newest result is kept at `conform/<repo>.yaml` in the change folder.
- `atticus task run` (and `atticus handoff done` for a task run) checks the task branch's commit against the task's steps when its build passes, and says what it found in the run's notes.
- `GET /api/changes/{id}/conformance` (API 2.11.0), the app's Code against design (More, Build; linked from the Tasks stage) with every item, its step, task, citation and finding state, and the read-only `change_conformance` MCP tool.
- Golden test on the Forge fixtures (`fixtures/conform`): forge-ledger after part of the transfer limit, with the hand-written result and findings.

### Fixed

- The synthetic-estate scale test and the changes package allow for a busy machine: their limits (180 s and 30 s) were hit when every package's tests ran at once, at about ten times their time alone.
- The index no longer reads `specs/estate.yaml` (the estate's joins) as a flow, which every search warned about on a real metarepo.
- An estimate with no days no longer says the waiting is longer than the work: there is nothing to compare it with.
- `pnpm check` passes again: the core-neutral check allowlists the English word "teams" and the C6 wiki types; the inbox's matching moved out of a .tsx file; journeys 19 and 20 read the page's token without DOM types; the context engine's timing test reports times instead of asserting them.

### Model runs, and what waits, in every surface

- The app: a Model runs screen (More, Run, `#/runs`) lists every model run, newest first, with a filter; one run shows its prompt beside its answer and, per earlier round, the problems the checks handed back with the answer that failed them, all as text. Every AI step the app shows as a command gets **Run with Copilot** in a VS Code tab, or **Run with <model>** in a browser when `runtime.yaml` configures one; otherwise it stays a command to copy. Each AI step's page links to its runs.
- The critic runs as an AI step (ADR 0106 addendum): `atticus critic <change> --handoff [--json]` offers its AI lenses one at a time, oldest first, each resume the next, and ends with the gate's verdict; so Run with Copilot, Run with the server's model, the VS Code runner and the IntelliJ console review a change. `atticus task run` stays a command (it edits code, in the assistant's agent mode).
- The app: a step run with the server's model links to the run it made (the job's result names it); Onboarding's survey step links to the surveys' runs.
- The app: Waiting on you lists what needs a person grouped by change (blocking first), then what belongs to no change; one filter box ("Filter: words to match") on Waiting on you, Questions (with a repo picker), Manual steps, the cross-change views and Knowledge items.
- A knowledge scan reads a big wiki in batches that fit the model: `atticus knowledge scan --batch-tokens <n>` reads only the changed pages that fit, keeps what it read, records only those pages as read, and says how many are left; the next scan carries on. The VS Code extension passes the model's room (its limit less 4,000 tokens for the instructions; GPT-4o mini on Copilot takes 12,078) and runs batch after batch until every page is read. Every page is still sent once; only the instructions repeat per batch.
- Model runs (ADR 0106): what Atticus asked a model, what it answered and what the checks handed back, kept under `.runs/` and now shown. `atticus runs [--change id] [--json]` and `atticus runs show <run> [--json]`; the local API's `GET /api/runs` (with the server's model, if any) and `GET /api/runs/{runId}/transcript`; and `POST /api/runs`, which starts an AI step on the server with `runtime.yaml`'s model, as a job, where one is configured (only the AI steps; never an argument that starts with `-`). API 2.8.0.
- `atticus waiting [--group change|kind] [--filter words] [--json]` (ADR 0105): what waits on a person across every change, grouped by change (blocking first) or by kind, with a filter.
- The Claude Code plugin's MCP server gains `waiting_on_you`, `open_needs`, `model_runs` and `model_run`; a session in a metarepo starts with how much waits on you.
- The IntelliJ plugin: **Waiting on You** and **Model Runs** actions (the toolbar and the Tools menu) open those app screens in its tool window, and a hand-off run in the console offers **Open the prompt**.
- The VS Code extension: Waiting on you grouped by change (or by kind), a filter on Waiting on you, Changes, Knowledge and Model runs, a Model runs section, Open the prompt and Open the answer on a step's ending, and Run with Copilot for the app in its tab; see its changelog.

### One arrangement in the app and the plugin

- The app's menu follows a working day (ADR 0105): Dashboard, Waiting on you (was Command center), Changes, the phase screens, Knowledge. More is regrouped into Code, Knowledge, Org pack, Define, Design, Plan, Build, Release and Run. Questions is a section of Waiting on you and stays at `#/questions`. No route is removed or renamed.
- Needs across changes: `#/changes?across=needs` lists every open need of every open change, with Done, Not needed and Reopen as on a change's page. Waiting on you shows questions, open needs, manual steps and blocking findings, each with its count and a link.
- The Dashboard's slash commands card, and every line that named Copilot Chat, say the commands are in Copilot Chat (`atticus assistant-files`) and in Claude Code (the Atticus plugin, ADR 0104).
- The VS Code sidebar in the same order: Next, Waiting on you (was Questions), Changes, Knowledge, Repos, Catalog; see the extension's changelog.

### Atticus for Claude Code

- A Claude Code plugin (ADR 0104), in this repository's marketplace: `/plugin marketplace add maycombhq/atticus`, then `/plugin install atticus@maycombhq`. Every step and catalog command as a slash command, the same files `atticus assistant-files` writes; a session in a metarepo starts with its next step; and the read-only `atticus` MCP server. `pnpm claude-plugin` writes `plugins/atticus` from the same commands, and a test fails when it is out of date.
- `atticus mcp`: read-only tools over MCP (stdio) for an assistant: the next step, catalog queries, explain and impact, knowledge items, changes and their status, needs and findings, open questions, features, triage and manual steps. Each runs the command's own code; a value can never be read as an option; nothing writes.

### A pair of glasses

- Atticus's mark is Atticus Finch's glasses (`docs/brand/glasses.svg`): two fine round lenses and a straight bridge, with a small curved glint at the outer top of each lens, like an eyebrow. Where the logo stands alone it carries the name below (`docs/brand/atticus-lockup.svg`): the VS Code Marketplace icon and the IntelliJ plugin icon. The app's header keeps the name beside the glasses; the favicon, the VS Code activity bar and the IntelliJ tool window use the glasses alone.

### Every screen says what is happening

- The browser app has a light theme. It follows your computer's light or dark setting by default; a Theme switch in the top bar (System, Light, Dark) is remembered in the browser. It uses the same colours as VS Code's light mode, and every screen passes WCAG 2.1 AA in both themes.
- Escape closes the Correct and Reject forms on Knowledge items, the Done and Not needed notes on a change's needs, and the artifact editor, and puts the keyboard back on the button that opened them.
- The app's words, screen names, menu groups, the tour and the Ask box among them, come from the copy file; a test fails when a screen has English typed straight into it.
- Verify, Correct, Reject, Keep, Done, Not needed and Reopen keep the keyboard on the item or need you acted on, and say "Working on it…" while they save.
- A need whose knowledge item was rejected says so; each need's buttons are named for the need; a reopened need is "open again".
- Opening a saved search keeps the search you typed; each Keep button names its candidate.
- An item link that no longer resolves says so; a never-synced source says "Not synced yet" rather than that its snapshot is too old; pages read `page.md (Heading)` on every screen.
- No screen scrolls sideways at 320 px; scrolling tables and code blocks take keyboard focus. The journeys add a keyboard run through knowledge review, a search's Keep and a change's needs (spec 16).
- A stopped server is said in words: one note at the top of the page names `atticus ui` and how to start it again (in a VS Code panel, Atticus: Open the app), with Try again; each panel only says it couldn't load. When the server answers again the screen loads afresh. No more "Failed to fetch", and a reply that isn't Atticus's says so with its status.
- A load that fails offers Try again. A screen that works on one change shows that the changes are loading, or why they didn't load, instead of a skeleton that waits forever (Feature brief, UX, reviews, mappings, Breakdown, Task board, Test trace).
- Every action button says it started ("Working on it…") and then what happened. The critic's outcome on a change's page no longer hides behind the hand-off's; each task's Run with AI keeps its own outcome.
- No silent clicks: an empty Ask, wiki search, impact search or sandbox folder says what to type; Check again (Reconcile, Settings) says "Checking…" and when it answered; searching the wikis for the same words searches again; the Architecture canvas no longer offers Open on the box it shows or a button for where you already are; Esc closes the tour.
- Disabled buttons say why: Not relevant and Waive need a reason, a rule that can't be waived says so, Check they answer says no tool is set up.
- The empty states say what to do next: a page that works on a change gives `atticus change new` to copy and the way to Changes; Knowledge items and Teams, vendors and products link to Knowledge sources and give `atticus knowledge scan` and `/atticus-knowledge` to copy; the Command center shows a dash, not a 0, for a count it couldn't read.
- The command line's "Re-run with --force" is said in the app's words: tick the box on the Service desk queue, or the command to run for stories.
- Links that leave the app (a hand-off PR, a request in the desk, a knowledge item's links) open beside it and say so to a screen reader; in a VS Code panel the editor opens them. The evidence pack, which a VS Code panel can't save as a file, is shown there to copy, with `atticus release evidence <change> --out <folder>`.
- The journeys' empty-state check covers all 41 screens, and the server-unreachable check covers seven, with axe on each; `ATTICUS_CHROMIUM` points the journeys at an installed Chromium.

### Fixed

- AI steps hold up with a real Copilot model (ADR 0103). Through a hand-off, each step's attempts now carry across resumes, so a step that never gets a passing answer stops after `--attempts` instead of handing it back for ever (the knowledge scan, ask and find, a change's needs, and the scan survey, verify, review and spec draft). An answer word for word the one that just failed ends the step instead of being asked for again.
- The quote check forgives the punctuation a quote ends with and single quote marks for double: a sentence cut short or a table cell quoted as a sentence matches; every word is still on the page, in order. A conflict that quotes the same words twice is refused.
- A change's needs take a cited file named with the change's folder in front (`add-transfer-limit/brief.md`, `openspec/changes/<id>/brief.md`), as Copilot writes it, and a quote ended with the model's own full stop.
- The command catalogue (`atticus commands --json`) says what every command does: summaries no longer end in the options they list (those are read as options), a description on the line under its command is read, and the commands that had none have one. The editors show these words.
- `atticus ui --parent <pid>` stops when that process ends. The IntelliJ plugin passes the IDE's, so a killed IDE leaves no server behind (only when the command line has the option, so an older one starts as before).
- The IntelliJ plugin finds `atticus` on PATH as npm installs it: it skipped npm's extension-less shell script for Git Bash beside `atticus.cmd`, which Windows never runs, and said the command line wasn't installed. Run a Command picks knowledge items, needs, features, manual steps, triage items, glossary terms, findings, onboarding proposals, stories, flows, systems and records, as the VS Code extension does.
- The IntelliJ plugin runs a change's needs and a wiki search in Copilot Chat (`/atticus-needs`, `/atticus-find`) and `knowledge ask` as a hand-off, instead of as plain commands; a next step `atticus next` gives a slash command for is always an AI step.
- `atticus ui --embed vscode` stops when stdin closes, so the server the VS Code extension starts ends with its window, even when the window or VS Code is killed.

### Knowledge and needs in the app

- The app has it all (ADR 0102), under More, Know:
  - **Knowledge sources**: each wiki with its git ref, folder, checkout, tags, owner and newest snapshot (with its commit), Sync for each, the `sources add` form (saved into `sources.yaml`, comments kept), what the last scan changed and the reviews to check again. Reading a source with the AI is given as `atticus knowledge scan --source` and `/atticus-knowledge` to copy.
  - **Knowledge items**: grouped by kind and searchable, each with its fields, quote, page and links; Verify, Correct (only the fields its kind allows, lists as lists, links as label and address) and Reject (with the reason), as you.
  - **Search the wikis**: the plain page search runs at once; `/atticus-find` to copy for the AI step; the saved searches, new and known, with Keep as the kind you choose.
  - **Teams, vendors and products**: what each team owns and uses, who owns each product, and their other names.
  - **Org pack from the wikis**: the drafted systems, verified or not, Draft and Accept the picked ones.
- A change's page (Changes, Feature design, Stories, Tasks) shows what it needs from the organisation, grouped as `needs.md`, with lead time, who handles it, links, steps and why, the tick or "not yet verified", and Done, Not needed and Reopen; or `atticus change needs` / `/atticus-needs` to copy before it has run.
- The local API 2.7.0 (additive): `/api/knowledge/sources`, `/api/knowledge/scan`, `/api/knowledge/items`, `/api/knowledge/search`, `/api/knowledge/finds`, `/api/changes/{id}/needs` and `/api/orgpack/draft`.

### Knowledge managed in the metarepo

- Wikis kept in git (ADR 0101): `type: git` in `sources.yaml`, an ADO or GitHub wiki or a docs repo, with `ref`, `path` and `checkout: clone` (into local state) or `submodule` (pinned under `knowledge/repos/`). `atticus sources sync` clones or updates it, dates each page by git and records the commit in the snapshot. `atticus sources add git <url> --save` writes the entry for you.
- People review what the knowledge scan read: `atticus knowledge verify|correct|reject <item>` writes `knowledge/reviews/<item>.yaml`. A correction (`--set catalogueItem=... --set steps="a|b"`) is what plans, answers and lists read from then on; a rejection leaves the item out of plans; `knowledge list` shows a tick, and "check again" when a rescan changed the item since.
- Rescans: `atticus knowledge scan` reads only the pages that changed since the last scan, keeps items' ids, and says what is new, changed and gone; `--full` reads every page.
- What a change needs (`atticus change needs <change>`, `/atticus-needs`): your assistant reads the change and the knowledge items and says which requests and processes to raise, standards to follow and teams to involve, for the change, a feature, flow, story or task, quoting the change's words; Atticus checks each. `needs.yaml` and `needs.md` carry each item's how-to, lead time and who handles it; `atticus needs`, `needs done|skip|reopen` record what a person did. The stories stage's suggested requests join the same list, and `atticus next` asks for it once a change is placed.
- Search the wikis: `atticus knowledge find "<term or phrase>"` (`/atticus-find`) finds the pages that mention it, has your assistant read just those and propose what isn't known yet, each quote checked; `atticus knowledge keep <item> [--as kind]` keeps one as an item you verified; `atticus knowledge finds` lists the searches.
- Links: knowledge items keep the links their page gives (a request's service-desk form, a runbook) in `urls`, checked on the page; a change's needs carry them to `needs.md`.
- `atticus setup` no longer ticks the org pack in a new metarepo: "The org pack's files are valid", then "The org pack has an owner", which waits for `pack.yaml`'s owner.
- The org pack drafted from the wikis: `atticus orgpack draft` proposes the profile's systems from the products and vendors the knowledge names, with their aliases and owners, each citing its item; `atticus orgpack accept <platform> [--only] [--verified-only]` puts them into `profile.yaml`. The scan reads aliases too.
- Unverified knowledge is used and marked: `needs.md` says which needs come from items no person has checked, a task's prompt includes the change's needs, and `atticus next` asks a person to check them (`atticus knowledge list --unverified`), syncs a wiki whose snapshot is over 14 days old, and asks for the org pack draft when the wikis name systems it lacks.
- Teams, vendors, products and projects: the knowledge scan reads them too, as `Party` records (with what a team owns and uses) and the new `Product` kind (C1, additive; API 2.6.0).

### Everything from the VS Code plugin, guided

- Start or bring in (the + in the Next section): create a metarepo, use Atticus in a repo, a practice metarepo, add repos, onboard a repo, bring in another team's repo, accept it, add knowledge; always there, not only in an empty window (ADR 0100).
- The setup checklist (`atticus setup`) in Next until the catalog is accepted, each step a click to what fixes it.
- Onboard a repo: clone, scan settings, scan, check the scan, spec, its questions, in order, each with its state; pick one to run it and the list comes back updated.
- A next step with a part to fill in (`atticus repos discover <folder>`) opens the screen that asks for it, not a terminal with the placeholder in it.
- `atticus absorb accept <id>`: copy what a reviewed absorb proposal adopts into the org pack (or OpenSpec, or inputs/) and add its `sources.yaml` entry; `--replace`, `--dry-run`, `--json`. Nothing is committed.
- `atticus absorb` reads TypeSpec: each `.tsp` file becomes a reference with its namespace, operations and models, read, never compiled; the compiled OpenAPI is absorbed for intake.
- Fixed: the sections refreshed only after a run's notification was closed; a made metarepo's "open it" slipped into the bell; empty sections' rows did nothing; came-back questions looked the same; `scan review` got the scan's options as required ones and `scan` lost `--repos` in the command catalogue; a repo not cloned yet scanned as `spawn git ENOENT`. Extension 0.2.0.

### An IntelliJ IDEA plugin

- `packages/intellij` holds a Kotlin plugin, built with Gradle against the IntelliJ IDEA on the machine (ADR 0099). Install the zip it writes with Settings → Plugins → Install Plugin from Disk….
- The Atticus tool window: it shows the app (`atticus ui`, on 127.0.0.1) in a metarepo. Without a metarepo it offers Create, Use Atticus in this project and a practice metarepo, and it says how to install `atticus` when the command line is missing.
- Atticus: Run a Command… lists every command by area, in plain words. The AI steps name their `/atticus-*` slash command for Copilot Chat, since IntelliJ's Copilot gives plugins no model. Shared writes run as a dry run first, and run for real only after Approve and run.
- Atticus: Next Step says the next step in plain words, with a way to do it.

### The VS Code extension for a first-time user

- Fixed: clicking the app's menu in the Atticus tab did nothing (ADR 0098). The bundled page's `<base>` sent the links elsewhere, and VS Code's panel also cancels every `#…` link click; the app now follows its own links in a panel. Extension 0.1.1.
- In the Atticus tab the app follows VS Code's theme: light, dark and both high-contrast themes, with every colour a theme token and AA contrast in each. In the browser it looks as before.
- Start from nothing: with no metarepo open, the sidebar offers Open, Create (`atticus init`), Use Atticus in this repo (`atticus adopt`) and a practice metarepo. A missing command line or Copilot Chat is said, with how to fix it.
- A Get started walkthrough, from installing the command line to a first change.
- Add repos (the Repos section's +): found in a folder of clones or a Git host organisation, shown with their types, added when you say yes.
- Plain words: the next step says what it does, and Run a command leads with what each command does. The developers' own commands are hidden (`atticus.showDeveloperCommands`).
- A Questions section, by repo.
- Shortcut keys: Ctrl+Alt+Shift+A (run a command), N (next step), D (the app).
- `pnpm --filter atticus test:vscode` runs the extension's checks inside a real VS Code.

### Ready for the Marketplace

- The VS Code extension has what a Marketplace listing needs:
  - a 256×256 PNG icon;
  - a dark gallery banner;
  - keywords, a homepage and an issues link;
  - its own CHANGELOG.md.
- `marketplace` and `marketplace:pre-release` scripts, with the steps in `packages/vscode/PUBLISHING.md`.
- The app's fonts are under the SIL Open Font License. It is now allowed for font packages only (decisions-pending item 19), and their licence text ships in the extension's THIRD-PARTY-LICENSES.txt.
- The Architecture outline says a gap every part shares once, on the part they are inside.

### The diagrams inside VS Code, from the extension's own files

- The Atticus tab loads the app from the extension's own files (ADR 0097), with a strict policy. Its calls go through the extension to the local API, so nothing on 127.0.0.1 is framed. It works where framing a local page is blocked, and over SSH or in a container.
- What it shows: the Architecture canvas, flows, target flows and every other screen. A file change refreshes the open view. Going to another view keeps the person's arrangement.
- The layout worker starts from a same-origin copy of its script.
- `atticus.appIn: frame` keeps the framed page.

### Every command in VS Code

- `atticus commands [--json]` (ADR 0096): every command as data. It records each command's arguments and what they refer to, its options, its area, and how it runs (with an assistant, as a shared write that needs approval, as a server, or locally). It is built from the help text, and a test fails if a command has no area.
- The VS Code extension offers all of them:
  - **Run a command…** and `@atticus /run` offer every command, each argument asked with a picker for its kind. A shared write shows its dry run and waits for your yes.
  - **Starting a change:** New change (the + button, or `@atticus /new`) asks for the type, opens the brief, then offers the feature stage.
  - **On a repo or a change:** "Run on this repo/change…" offers every command that takes it.
  - **New sidebar parts:** a change's Tasks, each with Run the task, and a Knowledge section with the sources and the items.
  - **Title bars** of the sections carry the everyday commands.
  - **Health:** an upgrade and machine check runs when the window opens.

### A change's target flows, before and after, and loops and retries as frames

- The Flows screen draws a change's target flows (ADR 0095) as one sequence. Each step says Added, Changed (with what it did before) or Removed, and shows the delta's reason. Components and tables the change adds are lanes marked new. Pick the change in the Flows screen's Change list, or follow the link on the Architecture page or the Target flows item in the VS Code sidebar.
- `GET /api/changes/{id}/target-flows` and `.../target-flows/{flow}` (API 2.5.0) give the steps merged and marked.
- Flow schema version 2: a loop or retry names the steps it repeats in `repeats: { from, to }`. They may come before it (a retry of a save) or after it (a loop over the next steps). The screen draws them as a frame. Version-1 flows still read. Run `atticus upgrade` to rewrite them.
- `atticus spec check` asks every loop and retry for `repeats` (`template-requires`), and `atticus spec draft` tells the drafter to write it.

### Cited lines in one call, record lenses, and acting on findings in VS Code

- `GET /api/cites?repo=&path=` (ADR 0094, API 2.4.0): each line of one file that a flow step or a catalog record cites. It uses an index the app builds at start-up and again when specs or the catalog change.
- The CodeLens uses it, one call per file. A line a record was read from says which records, and a click opens the record (`atticus.codeLens.records` turns these off).
- A finding in the sidebar has "Act on the finding": Apply the fix, I fixed it by hand, Not relevant, Waive it or Ask someone. It offers only what the critic allows and shows a patch before applying it.

### The VS Code extension shows Atticus's data beside the code

- A sidebar with Next, Repos, Changes and Catalog (ADR 0093):
  - **Repos:** each repo's flows, down to every step. A step opens the code at the line it cites.
  - **Changes:** each change's files and findings; a click opens the file.
  - **Catalog:** each kind's records; a click opens the record's YAML or the code it was read from.
- CodeLens in the code: above each line a flow cites, which flow and step cite it and whether a check confirmed it; a click opens the flow beside the code with the step marked (`atticus.codeLens` turns them off).
- A status bar item with the open questions and the next step.
- The Flows screen marks and scrolls to `&step=N`.

### Flows drawn as sequence diagrams

- The Flows screen (ADR 0092, under More → Know): a repo's spec flows, and the picked one drawn as a sequence of steps across lanes. The lanes are who starts it, the gateway, the component, and each component, table and topic it reaches. Each step shows its data, its file and line, and who confirmed it. A call another repo's flow answers links to that flow, and the error paths are listed with their citations.
- The specs API (API 2.3.0): `GET /api/specs`, `GET /api/specs/{repo}` and `GET /api/specs/{repo}/flows/{flowId}`, read from the spec folders and `specs/estate.yaml`.
- `@atticus /diagram <repo> <flow>` opens a flow in the VS Code tab; the Architecture details panel of a repo links to its flows.
- The Architecture canvas: a gap every part shares is said once, a fit never zooms below the size words can be read at, the tour stays closed inside an editor's tab, and a label in a primary button keeps its contrast.

### A VS Code extension runs the AI steps with Copilot

- `packages/vscode` (ADR 0090): an `@atticus` chat participant and a side view. `@atticus /next` reads `atticus next`, sends each AI step's prompt to the Copilot model the person picked, writes the result file and runs the step's finishing command. Atticus's command line still does every check; the extension only carries prompts and files. It stops at a question for a person and says what it is.
- `atticus <step> --handoff --json` prints the prompt, the result file and the finishing commands as one JSON object, for the extension.
- The app in a VS Code tab (ADR 0091): Open the app shows the app, its diagrams included, beside the code; `@atticus /diagram <repo>` opens the Architecture canvas on that repo. `atticus ui --embed vscode` lets only a VS Code panel frame the app, and the API keeps every header. `#/architecture?node=<id>` opens the canvas on one node.
- Not built yet: IntelliJ and a Marketplace listing. The extension is installed from its `.vsix`.

### Spec flows draw the steps a person draws

- `atticus spec draft` and `atticus spec check` (ADR 0089): a UI flow starts at the person's action (the form, the button; a page's route) and ends with what the screen does after the response. Two new findings say when it doesn't: `ui-start-not-action` and `ui-end-missing`, for action and page triggers only.
- A flow an entry point starts names who calls it and how the call arrives, in `trigger.caller` (the vendor or component, and the gateway or direct). When nothing in the code or config says, `atticus spec check` asks a person at once (`caller-unknown`), one question per component.
- Every validation layer is a step, and a transform step goes wherever data crosses types; `field-from-nowhere` now says to add the missing transform.
- A flow's `what`, `when` and `then` accept a bare number or true/false (`then: 404`), read as text, instead of costing a retry round.
- The UI words the critic reads by are in the spec template (`ui`), so an organisation with its own UI framework lists its own.
- A question another step already asked about the same repo (a cited line in common, or near-identical words) is reused, not asked again: the step is recorded on the question, reads its answer, and says so.

### The change lifecycle as three stage loops

- `atticus change feature <change> [--from-figma f.json]` (ADR 0087): your assistant places the change against the estate from its brief, its existing stories or an exported Figma design: the features and flows it touches, picked by meaning from a compact index of the repo specs and the catalog, the new flows it needs, gaps and questions. Every id is checked; other changes in flight on the same flows or systems are found from their files. A design's screens, fields and actions are read from the export and mapped; a field with no backing is a gap.
- `atticus change architecture <change>`: the target flows, one flow delta per flow at `target-flows/<flow>.yaml` (steps added, changed or removed, with fields), checked against the specs and the catalog; the interface and data changes go into `design.md` and `data.md`.
- `atticus plan stories <change>` on a change with target flows: a story per flow and repo, a task per changed step with its fields, evidence and a prompt for Copilot or Claude Code, and `requests.md`: the change tasks and service requests the knowledge items call for, each citing its item and the step. A person raises them.
- Every stage loops: draft, the stage's checks and a critic round on every draft, findings back to the assistant, with no cap on model calls. A finding that comes back unchanged twice, or comes back after it was fixed, becomes a question and the loop stops. When nothing blocks, the command prints the stage's PR for a person to approve.
- The critic's round limit is a setting: `gates.yaml` version 2 makes a gate with no `maxAuthorRounds` unlimited. `atticus upgrade` migrates a version 1 file and keeps each gate's two rounds until a person removes the line.
- `/atticus-feature` and `/atticus-stories` drive the loops; `/atticus-architecture` is new. `--handoff` works on `change feature` and `change architecture`. `atticus next` and the app's Run next name them.
- `atticus bench design [--mode m]` scores a design reading against `bench/design/reference.yaml`: screens, fields, backing, actions and gaps.

### Hosts asked, wrong families block joins, and lineage across a crossing

- `atticus scan` and `atticus estate join` ask which repo answers on each host the calls name that no repo lists under `hosts` (ADR 0088): one question per host, the repos that serve HTTP as options, and first the repo whose config sets the port (`server.port=9966`). Answering with `atticus questions answer` writes the host into that repo's `hosts` in `repos.manifest.yaml`.
- A manifest host can name a port (`localhost:9966`), so two services on one host are told apart. A host without a port still takes any port.
- `atticus spec check` finds a family that stands for other work (a read for a write, or a write for a read). `atticus estate join` won't join a call through such a family; the call-out is reported with the reason `family-mismatch`. A flow whose own trigger is the reached entry point always comes first.
- At a crossing, an object the caller sends (`owner`) is mapped to the fields the callee's entry takes. `atticus estate lineage` follows `firstName` from the UI's `owner` into the API, to its column.
- A write maps fields to columns with `data.from` and `data.to`. `atticus spec check` reports a written field no column takes (`write-unmapped`). The spec drafter is asked for every column a write writes, and how fields map to them.

### Every step as a slash command in Copilot Chat, and `atticus next`

- `atticus assistant-files` writes eight more slash commands (ADR 0086), for Copilot (`.github/prompts/`) and Claude Code (`.claude/commands/`): `/atticus-survey`, `/atticus-verify`, `/atticus-spec`, `/atticus-answer`, `/atticus-knowledge`, `/atticus-feature`, `/atticus-stories` and `/atticus-next`. Copilot's own model does the AI work; the command has it run `atticus` for everything else. `/atticus-spec` loops until the spec check passes. Every command stops at a question for a person.
- `--handoff` on `scan survey`, `scan verify`, `spec draft`, `knowledge scan`, `change draft` and `plan stories` prints only the prompt file, the result file and the two commands that finish the step.
- `atticus handoff done` now finishes scan survey, scan verify, spec draft, knowledge scan and onboard runs. Before, it checked their answers as change files and failed them.
- `atticus next [--all] [--json]`: the next step, its command, its slash command and why, worked out from the metarepo's files.
- The app's Run next shows the new slash commands where they apply.

### The estate pass: flows joined across repos

- `atticus estate join [--json]` (ADR 0085) matches every call-out in the metarepo's repo specs to the flow its target starts: through the catalog's Interface (and its gateway's base path), the Endpoint the step names, or method and path on the target component. A join needs a citation at both ends, checked in the clones. It writes `specs/estate.yaml`: each join and how it was matched, and each call-out not joined with why (no target, no flow, no citation).
- `atticus estate flow <flow-id> [--depth 5] [--json]` prints a flow followed across repos, the callee's steps inline at each call-out, with what is sent, taken and returned at each crossing. It stops at the depth limit and at a cycle.
- `atticus estate lineage <flow-id> <field> [--json]` follows a field from the step that sends it through transforms to the column a write stores it in, each step cited, or says where the chain breaks.
- `atticus spec check` finds a call-out's target through a base URL or context path (`/petclinic/api/owners` reaches `/api/owners`), the same rule the joins use.
- `atticus bench run --specs [--estate e]` also scans each estate's repos together in one metarepo, joins their specs, and scores the reference flows that cross repos and are reached end to end.

### Repo specs made of flows

- A new C1 kind, `Flow` (ADR 0079), with its own schema version 1: a trigger, ordered steps (entry, lookup, read, write, call-out, publish, transform, validate, branch, log, respond, loop, retry) with the data at each step by field, the table and columns a step reads or writes, where a call-out goes, error paths, a family of near-identical triggers, and a citation and `confirmedBy` (check, AI pass or person) on every step. Flows live in the metarepo at `specs/<repo>/<id>.yaml` with a header in `specs/<repo>/spec.yaml`.
- A repo type can carry a spec template, `repo-types/<id>/spec-template.yaml` (C6): which triggers a repo of the type has and where the catalog lists them, what each step kind must record, and how flows group into families. A built-in default template is used otherwise.
- `atticus spec draft <repo>` has your assistant write one flow per trigger from the catalog, the template, the repo type's skills and the answered questions. Each flow is checked (schema, every cited line, every catalog id, call-out targets, writes) before it is written; what fails goes back. It asks a person what the code doesn't settle. Later runs draft only what changed or failed.
- `atticus spec check <repo> [--json]`: the deterministic critic. Every trigger has a flow, every cited line exists, a call-out's target and a write's table and columns are in the catalog, a field doesn't appear from nowhere, and a step's claim is on its cited line (which marks the step confirmed by the check). A finding that comes back unchanged after a redraft becomes a question.
- `atticus bench run --specs` also scores drafted specs against the bench's reference flows (`bench/flows/`): triggers covered, steps matched in order, tables and fields named, citations correct.

### The app's six screens, and More

- The menu shows six screens that follow the work: Dashboard, Onboarding, Feature design, Architecture, Stories and Tasks. Every other page is under More, unchanged; nothing is removed. `#/` opens the Dashboard; the Command center is at `#/home`.
- Every one of the six shows "Run next": the command for its step with a copy button, and the slash command for Copilot Chat where `atticus assistant-files` writes one.
- Dashboard: repos listed, cloned, with scan settings and scanned; changes in flight and their stage; open questions; the slash commands that exist.
- Onboarding: the manifest file, each repo's clone, scan settings, last scan and the `atticus repo-type detect` command; the knowledge sources in `sources.yaml`; the steps in order (repos discover, workspace sync, scan survey, scan, answer, scan review).
- Feature design, Stories and Tasks: the change's files and the command for its stage; Tasks lists each task with `atticus task run` and `/atticus-task`.
- Local API (ADR 0084, 2.2.0): `GET /api/onboarding`, read from files only.

### The scan's AI verify step

- `atticus scan verify <repo>` (ADR 0082) hands your assistant what the last scan recorded for the repo (entry points, calls, tables and deployments, each with its file and line), its folders and its scan settings. The assistant lists what the scan missed, what it has wrong and what it confirms, each with the line it read and a fix: a scan settings entry, a question for a person, or a change a reader must make.
- Atticus checks every item: the cited line exists and says what is quoted, a missed entry point, call or table is named on its line and isn't in the scan already, a wrong or confirmed record is in the catalog, a settings entry passes the scan settings' own checks, and a question's evidence exists. What fails is handed back; what still fails on the last attempt is left out and listed.
- Results go to `proposals/scan/<repo>.yaml` (settings entries to accept, merged across runs, and the confirmed records pinned to their lines), `questions/`, and `proposals/scan/<repo>.findings.md` (what a reader must read differently, in plain words). The catalog isn't changed. `atticus scan verify <repo> --accept` checks the settings entries again and merges them into `org-pack/scan/<repo>.yaml`.
- `atticus bench verify` runs it on the bench repos and keeps the proposals in the bench cache; `atticus bench run` then says how many of the flagged misses and wrong records the reference agrees with.

### Knowledge sources tagged, snapshot, scanned and queryable

- Sources in `sources.yaml` carry tags (ADR 0083, C6): `tags: { kinds, frameworks }` beside the existing `owner`. `atticus sources tag <source> --kind k,k --framework f,f --owner o` writes them.
- `atticus sources sync [--source s]` also copies each source to a dated snapshot, `knowledge/snapshots/<source>/<date>/`. The knowledge scan reads only snapshots.
- `atticus knowledge scan [--source s] [--mode m]`: your assistant reads the snapshots, guided by the tags, into patterns, standards, processes, requests, decisions and constraints. Every quote is checked word for word on its page and under its heading; what fails is handed back. Conflicts between pages and superseded pages are flagged; text that tries to instruct AI tools is cut out, flagged and never followed. Items are written to `knowledge/items/`, flags to `knowledge/scan.yaml`.
- C1 (ADR 0083): a new `ProcessDefinition` kind; `Pattern` gains `patternKind` (pattern or standard), `rules` and the knowledge fields (applies-when, handled by, framework, tags, quote); `Decision` gains `decisionKind`, `stance` (mandated, banned, retiring), `dates` and the same fields. Existing files read unchanged.
- `atticus knowledge list [--tag t] [--kind k]` and `atticus knowledge ask "<question>"`: answers come from the items only and cite them; an answer with no valid cite is refused.
- `atticus bench knowledge [--mode m]` scans the bench's invented wiki, asks its eight questions and scores items, quotes, conflicts, the superseded page, the injection and the answers' citations against `bench/knowledge/reference.yaml`.

### Repo types, matched by fingerprint

- A new org-pack folder, `repo-types/<id>/type.yaml` (ADR 0077, C6). It holds what a kind of repo looks like (build files, dependencies, framework markers and folders, each with a weight), the scan settings every repo of the kind gets (written as patterns), and the skills for reading it.
- `atticus repo-type detect <repo> [--json]` scores the repo against every type and cites the file or line behind each signal. It says whether the match is clear, partial, none or a tie.
- `atticus repo-type new <id> --from <repo>` drafts a type from a repo, with no AI, for a person to edit.
- `atticus scan survey` gives your assistant the matched type's settings (resolved on the repo and checked) and its skills.

### The estate as one graph, opened a level at a time

- Local API (ADR 0081): `GET /api/graph/node/{id}` gives one node of the estate (estate, system, repo, component, endpoint, topic, client, store, table, deployment) with its children, its breadcrumbs and its edges, merged with a count and each with its evidence as `path:line` and its gaps; `?lens=` picks architecture, repo, data, integration or infrastructure; "uses" edges are the transitive reduction unless `?all=1`. `GET /api/graph/focus/{id}` gives a node and its neighbours. `GET` and `PUT /api/graph/layout/{view-key}` read and keep a view's arrangement in `diagrams/layouts/<view-key>.yaml` (C6, a new metarepo file).
- The app's new Architecture screen opens the estate through it: a lens switcher, breadcrumbs, the picture of the open node, an outline for the keyboard and screen readers (Tab, Enter to open, Escape to close), and a details panel with the evidence and the command for the next step. The picture is today's read-only canvas: dragging, zoom, the minimap and "keep this arrangement" come with the new canvas.
- `scoreLayout` and `LAYOUT_LIMITS` in `@maycombhq/diagrams` measure a laid-out view against the diagram spike's limits.

### Client base URLs in scan settings

- Scan settings (`org-pack/scan/<repo>.yaml`) take `clients` (ADR 0076): a base URL in front of the HTTP calls in the files an entry covers, for calls built from a name the entry lists (`environment.REST_API_URL`) and for paths with no host (an interceptor puts the base in front). Each entry cites the line the base is written on; the scan refuses one whose line doesn't say it, whose base isn't that value, or whose names aren't in its files. A resolved call cites both its own line and the base's.
- The frontend reader now records calls built from a configured base, with the base's expression: `GET ${environment.REST_API_URL}owners/{id}`, following class fields such as `this.entityUrl`; Angular `HttpClient` calls with type arguments (`this.http.get<T>(...)`); requests through an axios instance the repo makes (`api.get("/comments")` with `api = axios.create({ baseURL })`), also when imported by an alias such as `@/lib/api-client`; and `"/profiles/" + name` as `/profiles/{name}` (before, only `/profiles/`). msw mock handlers are no longer read as calls.
- `atticus scan survey` asks your assistant for client bases too, shows it the calls whose base the readers couldn't know, and checks its answer.
- Without settings, such calls are recorded but don't join anything; on the bench that shows as wrong calls until the repo is surveyed.

### Scanner plugins, pinned and sandboxed

- When a rule file can't say how to read an organisation's code, a scanner plugin can (ADR 0080): `org-pack/plugins/<id>/` holds `plugin.yaml` (what it emits, the repo types or dialects it applies to, its time and memory limits, the sha256 of its entry file), the plain JavaScript code, and golden tests in `test/<case>/`.
- The scan uses a plugin only when its code matches the pin and its tests pass, and runs it after the built-ins, in a worker thread with its own limits. It reads files only through the scan, and can't import anything, use Node, reach the network, start a process, compile code from strings, or read the clock. A plugin that tries, runs too long or uses too much memory is stopped and reported as a scan problem; the scan goes on.
- `atticus plugin test <id>` runs a plugin against its golden files; `atticus plugin pin <id>` writes its entry file's sha256 into `plugin.yaml`.
- Node's `vm` is not a hard security boundary; ADR 0080 lists what is enforced and what an OS-level boundary would add.

### You are your Git user; approving is the pull request

- Atticus knows you by the metarepo's Git user (`git config user.name` and `user.email`, ADR 0073). The app shows it in the top bar and every command records it; `--by <handle>` is now an optional override everywhere it was required (`change new`, `change handoff`, `finding`, `baseline`, `todo done`, `task run`, `glossary`, `initiative`, `outcome record` and the rest), and `digest --as` likewise. With no Git user, the OS user name stands in with a warning that says how to set it.
- No roles in the app: one sidebar and one Home for everyone, one tour. The view picker, role homes, role navigation and tours, and Settings' group-to-role mapping are gone, and so is "Groups are mapped to roles" in the setup checklist. `.atticus/me.yaml` keeps only your digest settings.
- No in-app approvals: a gate is approved when its hand-off PR merges, and the Git host's rules decide who may approve. `atticus change status` names the PR to merge instead of "Approvals needed"; `change handoff`, `change sync` and `change return` are a dry run until you add `--approve`. Approve buttons, "approvals waiting on you" and the role checks on waivers and on accepting the baseline are gone; a waiver, the baseline and release go / no-go are files recorded with your name that reach main through a pull request, and each command says so.
- Every write to the Git host, work tracker, service desk or notifications still needs your explicit `--approve` (or a button that says what it sends).
- Local API 2.0.0: `PUT /api/me` and `GET /api/me/approvals` are removed; `GET /api/me` returns your Git user (`user`, `name`, `email`, `source`, `warning`).
- `roles.yaml` is deprecated (C6): it still loads and validates, nothing reads it, and `atticus init` no longer writes it; nor are gate `approvers`, change-type `approvals` or the change policy's `privacy.role`, `risk.approvals` and `selfApproval` read. Move those rules to branch protection and CODEOWNERS.

### Scan review

- `atticus scan review <repo>` (ADR 0072): the gaps the last scan left (files no rule reads, unresolved calls and data access, modules where it found nothing) go to your assistant, which gives each a verdict (a rule can read it, an Atticus reader misreads it, a vendor, ignore, or a person must say) and writes a dialect for the readable ones. Every verdict and the dialect are checked against the repo before anything is written; a person accepts the dialect and the next scan reads with it. `--gaps` lists the gaps alone.
- The SQL reader no longer takes `IS DISTINCT FROM`, a CTE's name or `information_schema` tables as tables (found by the first scan review).

### Domain profiles from the catalog

- `atticus domain profile <system> [--out file]` (ADR 0071): a system's domain profile filled from the catalog: components and repos, interfaces with their consumers, data with who reads and writes it, related domains, features, and an evidence register of every claim. What code can't tell (owners, controls, retention) is Unknown and asked as an open question. An organisation's own layout goes in `org-pack/templates/domain-profile.md`.
- ASP.NET Core actions named `GetUserAsync` route as `getuser`, as ASP.NET Core does by default.

### Draft a change from its brief and the map

- `atticus change draft <change>` (ADR 0070): your assistant drafts the OpenSpec proposal, spec delta and interfaces from the brief and the part of the catalog the change is about, picked without AI. Atticus checks the draft (every system, call and interface is in the catalog or marked new, every requirement has a scenario) and sends problems back before anything is written.
- `atticus plan stories --draft` writes draft stories before the design is approved.
- In the app, calls inside one box are counted on it instead of drawn as a loop, and every graph draws on the layered canvas.

### A repo's own HTTP helpers are followed

- The frontend reader follows the helpers a repo writes around fetch and axios (ADR 0069): `post("reports")` through `post(path)` → `http(\`/api/${path}\`, { method: "POST" })`→`fetch(BASE + path)`reads as`POST /api/reports`, verified from code, across files through relative imports. An app with its own thin client now gives its calls, so its API's endpoints are entry points and features are found.
- Each module's component takes its type from its own build file: a React module in a Maven repo is `frontend`.
- The command center's system map draws the estate's context view, or the one system's components and links, on the same canvas as Diagrams.

### Diagrams draw the view; modules show what they build on

- The Diagrams screen draws the chosen view itself (ADR 0068): Data shows each component's reads and writes to the tables inside their store, Container a system's components and their links, with a layered layout where no label sits on another. Pointing at a box lights its edges. `GET /api/diagram/{view}/graph` and `atticus diagram render <view> --format json` give a view's groups, nodes and edges.
- `Component.uses` (C1, optional): the modules of the same repo a module's pom or package.json depends on. The container view draws them as `uses` edges.
- A JPQL `@Query` is read against the entity's table (`@Table`, `@Entity(name)`, else Spring's naming), not the entity's name; a PostgreSQL or MySQL upsert and `SELECT ... FOR UPDATE` no longer give a table called `set` or similar.

### Discover: a clone's subfolders are its modules

- `atticus repos discover <folder>` on a folder that is itself a Git clone proposes one repo, with each subfolder that builds (a pom, a package.json, a pyproject and so on) as a module with its own component (ADR 0057). A clone inside it stays a repo of its own. A folder of clones is read as before. Discover now writes `modules` into the manifest.

### Shared parse cache

- Each file is read and parsed once per repo scan and shared by every reader (ADR 0067): built-in extractors, dialects and their rules, the Helm and Kustomize builders, Terraform and the framework survey. Tree-sitter trees, JavaFiles, SourceFiles, YAML documents, flattened configuration, HCL, XML and Groovy calls are cached, keyed by path and content. Values are frozen, so a reader that changed one fails instead of changing another's; the cache is bounded (8M characters of plain values, 1M of syntax trees, 16M of file text, least recently used first out) and frees every tree when the repo's scan ends, on error too. The SDK's `RepoHandle` gains an optional `parseCache` (`createParseCache`, `withParseCache`); handles without one work as before. Records are byte-for-byte unchanged. On the M1 exit estate parses per file went from 2.9 to 1 and the first scan of 300 repos from 59 to 90 s to 32 to 41 s.
- Tree-sitter grammars run as baseline WebAssembly code: V8 compiling them to optimised code took up to 2.2 GB of transient memory per process and killed test workers under load ("Fatal process out of memory: Zone", exit 0x80000003). The `frameworks-cli` test worker now peaks at 184 MB instead of 2.6 GB.

### Onboarding framework models

- `atticus onboard framework <name> --from <source|jar|tgz> [--users <repo>,...]` (ADR 0066): the learner reads the house framework first, then your organisation's assistant drafts only what it couldn't (base URLs of service ids, wrapper methods whose parameters don't name the method or path, what pipeline templates and Jenkins shared-library steps do), with the framework kit as instructions and the code as data. Checks decide: valid C6, every entry with a source, nothing read from code changed by the draft, drafted entries citing a document or a person, its tests pass, and the repos that use it give something with it they don't without it and no invalid record. Failures go back to the next attempt (`--attempts`, default 3). A passing model is a proposal in `proposals/frameworks/`, listing what it reads per repo, which records came from drafted entries, and entries that change nothing. With AI off or `--no-ai`, the learned model alone is checked.
- `atticus onboard check framework <name>` runs the same checks on a hand-written or handed-off model (with `--from`, the learner's entries are confirmed and merged in); `atticus onboard accept framework <name> [--replace]` (or `onboard accept <name>`) moves it into the org pack.
- `atticus scan` names house frameworks several repos import that no model covers, with the command to onboard each (`unmodelled` in `--json`), and models that read nothing any more in repos that import them (`coverage[].redraftFrameworks`), with the re-draft command.
- `atticus onboard eval` grades framework cases too (`kind: framework` in `case.yaml`): the first, `harbor-kit`, an invented Java starter and two repos using it; the eval runs 11 cases.
- `frameworks survey` and the scan share one import reader (moved to `@maycombhq/extractors`); the survey's output is unchanged.

### Model providers

- Model mode can call a real model (ADR 0065). A new package, `@maycombhq/model-providers`, ships three providers the CLI registers when it starts: `anthropic` (Messages API, directly or through a gateway), `openai-compatible` (Chat Completions, for internal LLM gateways, vLLM and similar; `flavour: azure` for Azure OpenAI deployments with `api-key` and `api-version`, also as `type: azure-openai`) and `bedrock` (the Converse API, SigV4 signed with `node:crypto` from the standard AWS environment variables; no AWS SDK).
- Keys stay out of `runtime.yaml`: `keyEnv` names the environment variable that holds the key, a setting that looks like a key or token is refused, and messages, run records and inspected objects never show a key. `baseUrl` must be `https://` except on this machine.
- Corporate networks: `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (with proxy credentials in the URL, never printed), `NODE_EXTRA_CA_CERTS` and a `caFile` setting. Timeouts (`timeoutMs`), cancellation, and bounded retries with backoff on 429 and 5xx that honour `Retry-After` up to 60 seconds. Each failure says what to check: the key variable on 401, the model or deployment on 404, the proxy on 407, the CA on an untrusted certificate.
- Usage comes from the response's token counts. An answer cut off at the output limit or declined by the provider fails the run rather than being used.
- Contracts, additive: C5 `registerModelProvider` (an organisation's own provider registers the same way), C6 `adapters.model.type: openai-compatible`. `models.allowed`, `modes.allowed`, `ai: off` and text-only work as before.
- New dependency: undici (MIT), for the proxy. Not built: streaming, Vertex AI, AWS profiles and SSO, Azure managed identity, images and tools. No provider has been called against a real endpoint from this repo; tests use an injected transport or servers on 127.0.0.1.

### Helm and Kustomize

- Helm charts are read without running Helm (ADR 0064): each chart once per environment values file (`values-<env>.yaml`, `values.<env>.yaml`, `values/<env>.yaml`, `environments/<env>/values.yaml` and the like) layered over `values.yaml`, with local subcharts (`charts/<name>`, `file://`, `alias`, `condition`, `tags`, globals). Templates go through a small Go-template reader (a tokenizer and parser for `{{ }}` actions, not text patterns) that evaluates `.Values`, `.Chart`, `.Release.Name`, variables, `if`/`else`, `with`, `range`, `include` of the `helm create` helpers and the common functions (`default`, `quote`, `toYaml`, `nindent`, `printf`, `trunc`, `trimSuffix`, ...). Anything else (`tpl`, `lookup`, `.Files`, `.Capabilities`, `.Release.Namespace`, unknown functions) is left unknown: the field is dropped, never guessed, and a template whose condition depends on one is skipped with a warning naming its line. The release is taken to be named after the chart. Dependencies that aren't in the repo are reported, not fetched.
- Kustomize overlays are built without running kustomize: resources, bases and components, strategic-merge and JSON 6902 patches, namespace, namePrefix/nameSuffix (references to renamed objects follow), commonLabels and labels, commonAnnotations, images, replicas and `configMapGenerator` literals. Remote bases are never fetched and fields not read (`replacements`, `vars`, `helmCharts`, ...) are reported.
- The openshift (0.3.0) and ingress (0.2.0) extractors read the built objects: Deployments, Ingress hosts, HPAs and NetworkPolicies per environment, with evidence at the template or resource line and at the values file, kustomization entry or patch behind it. A workload from a chart or overlay also gives `image` and `env.<NAME>` settings per environment (ConfigMap values filled in, secrets as `secret:<name>/<key>` references).
- Behaviour change: in a repo with kustomizations, base objects come out once per overlay rather than once under no environment, and overlay patch files are no longer read as objects of their own. Other manifest readers and repos without charts or kustomizations read as before.

### Cloud resources and Terraform modules

- Shipped dialects `terraform-aws`, `terraform-azure` and `terraform-gcp` (ADR 0063) read cloud resources from Terraform in every repo with a `.tf` file: SNS topics, EventBridge buses, Kafka topics, Service Bus topics and event hubs as event topics; Service Bus and Cloud Tasks queues, DynamoDB, Cosmos DB, MSK, Redis caches and Spanner as data stores; Lambda and Azure function apps as function components with a deployment; ECS services and App Service web apps as deployments; API Gateway v2 routes, first-level v1 resources and API Management APIs as gateway routes. An org-pack dialect of the same name replaces one.
- Terraform databases (Cloud SQL, RDS instances and clusters, Azure PostgreSQL and SQL servers) moved from the infra extractor's regular expression into those dialects: the same records, now with names and engines resolved from variables, and blocks read by the HCL parser. Azure PostgreSQL single servers and MySQL flexible servers are read too. The infra extractor no longer reads `.tf` files.
- Local Terraform modules are followed: a `module` block whose source is a folder of the repo makes an instance of that folder with the caller's values, so each instantiation's resources give their own records, nested modules included. A module folder that is called is no longer read on its own with its defaults, and a resource in it whose name the caller doesn't give is skipped rather than named after its label. Remote modules stay module blocks a dialect matches.
- Dialect templates: filters `before('x')` and `after('x')`; in `hclBlock` matches an object attribute's fields are dotted (`${attr.tags.env}`) and a reference to another resource is `${attr.<name>.ref}`, for lookups.
- `atticus onboard`'s survey counts what the shipped cloud dialects read as read.
- Not read yet: Lambda triggers, API Gateway integrations, EventBridge rules, module outputs, `count` and `for_each`; clusters (EKS, AKS, GKE) give no record.

### Pipelines from any CI/CD tool, and what org templates do

- Shipped dialects for Harness pipelines, Tekton Pipelines and Argo CD Applications (ADR 0062): a Harness or Tekton pipeline is a pipeline QualityAsset with stages, environments, deploy targets, test steps and templates, like the built-in readers write; an Argo CD Application is a GitOps Deployment.
- Framework models can have `pipeline` entries: what a template (`uses: org.tide_release`, `deploy.yml@templates`, a GitHub action) or a Jenkins shared-library step (`step: deployToProd`, `environmentFrom: env`) adds. Every pipeline that uses one gains it after the scan, and `details.modelled` says which model said so and where that came from.
- Dialects: `appliesTo.repoTypes: ["*"]` (any repo, gated by the marker); a `map('a=b')` filter; `where` on collected list items; `jsonPath` reads every document of a multi-document YAML file; `contains` on any match skips files without the given text before parsing them.
- Three onboarding eval cases (Harness, Tekton, Argo CD); `atticus onboard eval` runs 10.

### Dialect fields: nested objects, collected lists, the component

- A dialect field may be an object, nested up to three levels, and a list item may collect one value per node under the match: `{ each: "@.stages[*].stage", value: "${item.name}" }` (ADR 0061). `${repo.component}` is the component the matched file belongs to. A pipeline from any CI/CD tool can now be described as rules the way the built-in readers describe one.

### Rules read syntax trees, not text patterns

- Java and Kotlin are read from their syntax trees (ADR 0060): one reader for the Spring extractor, dialects, the framework learner, batch, GraphQL and realtime. It gives what the hand-written lexer gave on every fixture file, and more: Kotlin `object` declarations, interface methods without a body, constants declared in companion objects. Calls are listed in source order, so a WebClient chain still reads its verb.
- The Spring extractor no longer scans source text: constants (`static final String`, `const val`), the declared types of fields, parameters and locals (for wrapper clients and `receiverType`), whether a file uses Spring or a client, and `HttpMethod.X` all come from the tree.
- The ORM and vocabulary readers read code from syntax trees too, through one call layer (callee, receiver, positional and named arguments, string values) for Java, Kotlin, TypeScript/JavaScript, Python, Go, C# and Scala: JPA entities (every field, nested annotations such as `@Table(indexes = @Index(...))`; the Java tokeniser is gone), EF Core (attributes, DbSets, `Entity<T>()` and `ToTable` chains) and SQLAlchemy models, and the code side of the GraphQL, gRPC, realtime, webhooks, serverless, apps, data-pipeline and ML readers. Code in a string or a docstring is no longer read as code, and a declaration or attribute can span lines. Datadog resources in Terraform go through the HCL parser. Swift, Dart, .proto, GraphQL SDL, Prisma and SQL have no grammar here and keep their own readers.
- The Spring extractor no longer scans source text: constants (`static final String`, `const val`), the declared types of fields, parameters and locals (for wrapper clients and `receiverType`), whether a file uses Spring or a client, and `HttpMethod.X` all come from the tree. The JPA reader still tokenises, until it moves too.
- The generic-tier call layer reads syntax trees too (ADR 0060): the .NET, Python, Go and Node extractors and house frameworks get their tokens, calls, arguments, assignments and imports from the C#, Python, Go and TypeScript/TSX/JavaScript trees, and the hand-written lexer is gone (`SourceFile.parse` replaces `new SourceFile` and `lexSource`). Every fixture gives the same records. What a file imports is read from its import statements, not searched for in its text; the frontend extractor reads calls from the tree (Vue `<script>` blocks too), so a `fetch("/x")` in a comment or a string is no longer a call; method declarations, `raise X(...)` and `for rows.Next()` are told apart correctly; typed declarations (`x: str = "a"`, `var x string = "a"`) assign `x`; generic arguments (`Message<string, string>`) no longer split an argument.
- A `syntax` match (ADR 0060): a tree-sitter query over the file's syntax tree, for Java, Kotlin, TypeScript, TSX, JavaScript, C#, Python, Go, Scala, Ruby, PHP and Rust. Captures are `${capture.<name>}` (string literals unquoted) in templates, `where` and `lookups`, so a lookup over the tree can be the repo's constants. A call in a comment or a string isn't a call. The grammars ship with Atticus (web-tree-sitter 0.22.6, tree-sitter-wasms 0.1.13); nothing is downloaded or compiled.
- The framework learners read trees too: `atticus frameworks learn` takes a Java starter's `@AliasFor` members, constants and public methods' parameters from the Java tree, and a JS or TS framework's (or a package's `.d.ts`) exports from the TypeScript, TSX or JavaScript tree, so commented-out code and code in strings teach nothing. House dependencies read poms through the XML reader (a commented-out dependency isn't one) and `build.gradle.kts` through the Kotlin tree, including `group =, name =, version =` arguments. Groovy `build.gradle` and Jenkinsfiles are still read as text until a Groovy grammar ships.
- `atticus dialect tree <file>` prints a file's syntax tree, with the node names a query uses.
- Groovy (`.groovy`, `.gradle`, `Jenkinsfile`) is a syntax language too: its prebuilt grammar is vendored with its licence. Jenkins pipelines (stages, triggers, steps, test and coverage reports) and Groovy `build.gradle` coordinates are read from the Groovy tree, so commented-out stages and dependencies are no longer read.
- `atticus onboard` gives the assistant the syntax trees of sample code files, and refuses a draft with a `regex` match. `regex` is deprecated in hand-written dialects.
- The dialect kit's reference documents `syntax`, and a worked example reads a house client in Java, Kotlin and TypeScript.

### Onboarding: your assistant drafts the dialect

- `atticus onboard <repo>` (ADR 0059): a deterministic survey of the repo (what is read already, the structured files nothing reads), a draft dialect from the organisation's assistant through the AI runtime (the dialect kit as instructions, the repo as data), and checks: valid C2, its own tests pass and exercise every rule, it reads records from the repo and none is invalid. What failed goes back to the next attempt (`--attempts`, default 3). A passing draft is a proposal in `proposals/dialects/`; `atticus onboard accept <name>` (a person) moves it into the org pack. `atticus onboard check <name> --repo <repo>` checks a hand-written or handed-off draft the same way.
- `atticus scan` names the repos it read nothing from though they have structured files no reader knows, with the command to onboard them.
- It also names rules that need re-drafting: a dialect a repo's manifest entry names whose tests now fail (the scan leaves it out), or that reads nothing in that repo any more (a framework upgrade, a renamed file). `atticus onboard <repo> --name <dialect>` re-drafts it; `onboard accept <dialect> --replace` takes the new draft. Coverage (`--json`) lists them per repo. Coverage (`--json`) lists each repo's unread structured files.
- The dialect kit ships the three gateway dialects as worked examples.
- `atticus onboard eval <dir>` scores the assistant's drafts: for each case (a repo and a reference dialect a person wrote) it compares what the draft reads from the repo with what the reference reads, by content, and reports precision and recall. `fixtures/onboard-eval` has seven invented ecosystems: Apigee with target servers, Kong, Azure APIM, AWS API Gateway, a house edge gateway, a house HTTP client in three languages, and house Terraform topics. CI runs it with a stand-in that answers with the references; run it with `--mode model` where your model is.
- Dialect templates read nested fields of structured files with dots: `${attr.forward.service}`, `${node.up.match.prefix}`; a match's ancestors include the document's top-level fields.

### Dialect rules v3: any gateway, read through rules

- Dialects take `lookups` (ADR 0058): tables built from other files of the repo, read with `${lookup:<table>(<key>).<value>}`, the key any template value with filters. A key with no row, or with rows that disagree, leaves the value unknown.
- `${node.key}`, `${node.up.<field>}` and `${node.up.up...}` read the structure around a `jsonPath`, `xpath` or `hclBlock` match: a route's service, an element's parent. New filters `parent` and `basename`. A rule's `emit` may be a list.
- `fixtures/gateways`: an invented estate whose calls go through three gateway products, each read only through an org-pack dialect: Apigee with target servers per environment, Kong's declarative config (nested services, several paths per route), Azure API Management's APIOps folders. Every call joins end to end, caller to gateway route to service, verified at both ends. The three dialects are the reference an assistant's draft is graded against.
- Fixed: the dialect kit's reference had a block of itself pasted into the `where` section since rules v2.

### Harbor gaps closed

- Calls to a vendor join the vendor's system: a host label that is a vendor system's id, name or alias from the profile, without spaces or dashes (`api.tidewater.example` → Tidewater Payments, `api.lanternmail.example` → Lantern Mail), when exactly one vendor matches. It is checked before a host's first label, after declared hosts. Harbor's three vendor interfaces, and the h01 and h09 findings from a scanned catalog, now pass.
- golang-migrate files are read: `<version>_<name>.up.sql` gives the version, in numeric order, and the `.down.sql` files that undo them are skipped.
- A vendor's OpenAPI 3.1 `webhooks` are read: each is a `webhook-send` loose end, joined to the one webhook endpoint whose path names the vendor (`/webhooks/tidewater`), via webhook.
- Profile systems take `tags`, copied to the System record (`saas` marks a SaaS vendor, ADR 0040).
- Feature detection starts flows at GraphQL operations, webhooks, websockets and server-sent events too, not only REST, gRPC and SOAP.
- Reconcile matches a diagram edge drawn as `POST /pkg.Service/Method` to the gRPC interface.
- Intake reads Mermaid files as diagrams and links the systems their boxes name, and takes Jira REST search exports and Azure DevOps work-item batches as ticket exports, not payload samples.
- The unattended-workload check covers data pipelines and anything started by a schedule.
- Every Harbor test runs: none is skipped, and every expected record has a producer.

### One component per deployable module

- A repo that builds several deployables has a component for each (ADR 0057). `repos.manifest.yaml` may list a repo's `modules` (folder, component, hosts); without them, a multi-module Maven or Gradle repo with two or more `@SpringBootApplication` modules gets one component per app, named by its `spring.application.name`, else its folder. Endpoints, calls and loose ends belong to the module their file is in (Spring, house frameworks, the .NET, Node, Python and Go backends, OpenAPI files); a module's hosts join calls to it; calls between a repo's own apps are interfaces. The repo's own component stays, for what is outside every module.
- Extractors see the modules as `ScanContext.modules` (C4, an addition).
- The messy estate gains a multi-module repo: an API, a nightly job that calls it, and a shared library.

### Dialect rules v2: infra repos, conditions, honest rules

- Dialects read Terraform (ADR 0056): an `hclBlock` match (`module`, `resource.aws_sqs_queue`) supplies each block's attributes, resolved from the folder's variable defaults, `terraform.tfvars`, `*.auto.tfvars` and locals, and its labels. With YAML and JSON (`jsonPath`) and XML (`xpath`) matches, infra and pipeline repos built on house modules, charts and templates are read through dialects.
- Rules take `where` conditions: `{ value: "${attr.source}", matches: "tide-kafka-topic" }`. All must hold for a match to emit.
- A record a rule can't complete (a field C1 requires couldn't be filled) is skipped with a warning naming the rule and the field, instead of being emitted invalid.
- `receiverType` is applied: a `methodCall` rule with it matches only calls on a field, parameter or variable declared with that type, or a static call on the type. Before, it was accepted and ignored.
- A dialect's tests must exercise every one of its rules; a rule that produces nothing in any test fails `atticus dialect test`, and a scan doesn't use the dialect. Shipped dialects gain the tests they lacked (Micronaut `@Put` and `@Patch`, Quarkus outgoing channel topics).
- The messy estate gains an infra repo whose topics come from a house Terraform module, read through an org-pack dialect.
- The dialect kit's reference, README and checklist cover all of it.

### House frameworks in any language

- `atticus frameworks learn <name> --from <dir|package.tgz>` learns a JavaScript or TypeScript framework: from its source, or from its published npm package alone (its typings, else its JavaScript; nothing is run or installed). Exported functions and the methods of exported clients and routers become calls and routes, by their parameter names, positional or object properties; exported string constants are kept. Learned entries replace hand-written ones and make verified facts; a model's tests and a person's services are kept. `frameworks discover --group @scope` finds house npm packages in package.json files and looks for them offline (`--jars` folders of .tgz files, installed node_modules). The messy estate's Lantern source and package are fixtures; learned, the BFF's routes are verified.
- A bounded reader for gzipped tar archives (npm packages) joins the ZIP reader in core.
- `atticus frameworks survey [--package <prefixes>]` shows how the estate's repos use house frameworks in any language: each house module they import, the model that covers it, and how each imported name is called or annotated (`useApi(...)`, `lantern.call(...)`, `@InternalApi`, `BankHttp.exchange(...)`), with counts and a sample line. `atticus frameworks kit [dir]` exports the framework-model kit for an organisation's assistant: a guide, two worked examples, the schema, a checklist and a task prompt. New guide page: [Teaching Atticus your house frameworks](docs/guide/frameworks.md).
- Framework models carry their own tests (ADR 0055): sample files and the records they must give (`http-call POST https://…`, `endpoint GET /x/{id}`). A scan uses a model only while its tests pass and every entry a person or document wrote is exercised; otherwise the model is left out with a problem saying why. `atticus frameworks check [name]` runs them. `frameworks learn` keeps a model's tests. The messy estate's two models ship tests (Java and TypeScript examples).
- Framework models describe calls and routes in any language (ADR 0055): `calls` (a function, its receiver, the module it comes from, which argument or object property holds the method, service and path; HTTP, events or queues) and `routes` (calls that register a served route). A new built-in extractor applies them to JavaScript and TypeScript (JSX and TSX too), C#, Python and Go, in files that import the framework, filling names from the repo's own exported constants and the model's service ids. Service ids may be plain (`payments`) and packages may be npm modules (`@tide/lantern`).
- The messy estate gains Lantern, an invented React SPA and Node BFF framework: the SPA's `useApi({ service, path, method })` and `lantern.call(...)` calls reach the BFF through its declared host, the BFF's `defineRoute` and `router.route` registrations are endpoints, and the chain continues from the TypeScript BFF to the Java service's house controller.

### House frameworks, read through framework models

- `org-pack/frameworks/<name>.yaml` (ADR 0054): what a house framework means, in terms the scanner already reads. Its annotations stand for Spring's (`@InternalApi` → `@RestController` + `@RequestMapping`, `@Op(verb, path)` → `@RequestMapping`), its wrapper client is an HTTP call (`bankHttp.exchange(Services.AUDIT, "POST", "/audit/events")`), and its service ids and constants have values. Every entry says where it was learned (code, bytecode, a document or a person); only code and bytecode make verified facts. `atticus orgpack validate` checks the files.
- `atticus frameworks learn <name> --from <repo>` learns a model from a house starter's source: its `@interface` declarations (what each is meta-annotated with, house-on-house too, and `@AliasFor` as the attribute mapping), the public methods of its HTTP wrapper (service, method and path by parameter name), and its `static final` constants. Learned entries replace hand-written ones of the same name; what a person added (service URLs) is kept. What code can't say is printed as a note.
- `atticus frameworks learn <name> --from <starter.jar>` learns the same model from a compiled starter, for teams that have only its JAR: a small, bounds-checked class-file reader takes the annotation types (meta-annotations, `@AliasFor`), the wrapper's public methods with their parameter names (kept by `-parameters` builds, or the debug variable table) and `static final` constants, and the coordinates from `META-INF/maven/.../pom.properties`. Every entry's source is `bytecode`, naming the class inside the JAR and the JAR's sha-256. Nothing in the JAR is run.
- `atticus frameworks discover --group <prefix>` finds the house artifacts the estate builds on: it reads every repo's Maven poms (all modules, `${property}` versions) and Gradle builds, says which repos use which version, and looks for each JAR on this machine (`--jars` folders, then the Maven and Gradle caches). A JAR that isn't here is named, never downloaded. `--learn` learns each JAR it found.
- The safe ZIP reader moved to core (one reader for documents and JARs); ingestors re-exports it.
- Liquibase changelogs are read: formatted SQL (`--changeset author:id`), XML and YAML change sets (`createTable`, `addColumn`, `dropColumn`, `renameColumn`, `renameTable`, `createIndex`, `dropIndex`, `dropTable`, `addPrimaryKey`, `sql`), in the master changelog's include order. Each change set is a `liquibase` Migration, and the tables, columns and indexes are the same as the same changes written for Flyway. Flyway files in folders under `db/migration` are read too.
- Merge grows linearly with the estate: 1,600 components (about 100,000 records) merge in about 2 seconds, where 400 took over 5 and 800 about 20. Endpoints, tables and stores are looked up through indexes instead of scanned once per loose end; results are unchanged.
- Configuration is read the way Spring reads it: every YAML document (one with `spring.config.activate.on-profile` belongs to that profile), base config first, then production's values (`prod`, `production`, `prd`, `live`) for keys only profiles set, then the other profiles'. Before, `application-dev.yml` won over `application-prod.yml` because its name sorted first. Placeholders resolve innermost first and through values (`${a:${b:x}}`, `url: ${base}/v2`), and each module of a multi-module repo resolves its calls from its own config first.
- Constants are read from the whole repo, not just the file using them: `@RequestMapping(ApiPaths.CARDS)` with `ApiPaths.java` elsewhere in the repo is a verified endpoint `/cards`, and Kotlin `const val` counts too. A name defined twice with different values stays a loose end.
- The Spring extractor reads files that use a modelled framework even when they don't import Spring, and turns a file using one into a warning when nothing was read from it.
- The messy estate's two known gaps are closed: its house controller is an endpoint (inferred: a person wrote the model) and its wrapper call reaches `https://audit.tide.internal/audit/events`.
- A Spring property placeholder in a served path (`"${api.base}/x"`) is a loose end, not a verified endpoint whose path holds `${api.base}`.

### The messy estate: the catalog-truth gate

- `fixtures/messy`: an invented bank (Tidewater) written the way real teams write code (constants, `@Value` base URLs, a house starter, a wrapper client, Kotlin, JMS, a password in the datasource URL, a broken template, a gateway with a declared host). `packages/scanner/test/messy.test.ts` checks a scan finishes, makes no verified fact the code doesn't spell out, shows every client call, joins through the gateway only on its host, keeps no secret and reports coverage. The house annotation and the wrapper client are recorded as known gaps for phase 3.
- Fixed, found by it: merge dropped loose ends of every kind it doesn't join (`http-endpoint`, `mq-publish`, `mq-subscribe`, and any a dialect emits), so they never reached the catalog. They now pass through. A `kafkaTemplate.send` was also taken for a JMS send.

### Every client call is seen, joined or not

- A Spring call whose URL or topic the code builds (`restTemplate.postForObject(base + PAY, ...)`, `kafkaTemplate.send(Topics.PAYMENTS, ...)`, WebClient `.uri(...)`) is a loose end showing what it was built from, instead of nothing. Same-file `static final` String constants and `@Value` fields are filled in, so `base + PAY` reads `${nw.endpoints.payments}/v2/payments` and config resolves it where it can.
- JMS sends (`JmsTemplate.send`, `convertAndSend`) and `@JmsListener` destinations are recorded (`mq-publish`, `mq-subscribe`).
- A file that imports an HTTP or messaging client (RestTemplate, WebClient, Feign, Kafka, JMS, IBM MQ) but gave nothing is a scan warning.
- `atticus scan` prints how much of what it found it joined (`Joined 21 of 30 calls, listeners and endpoints found (70%)`); `--json` has `coverage` per repo: interfaces, loose ends and unread files.
- The Java reader reads Kotlin's `package` and `import` lines, which have no semicolon; before, the first import swallowed the rest of the file.

### No secrets in the catalog

- A Spring datasource URL loses its credentials before it is recorded, in every JDBC form (`user:pass@`, `?password=`, `;user=..;password=..`, Oracle's `scott/tiger@`); a URL that could still hold one is left out. Before, `spring.datasource.url` went into catalog files, the catalog site and context packs as written.
- Settings whose names hold credentials (`pwd`, `passphrase`, `credentials`, `api-key`, `access-key`, as well as `password`, `secret`, `token`) are recorded as `(secret)`.

### No facts made from what the code doesn't spell out

- `repos.manifest.yaml` takes `hosts` per repo (ADR 0053). Calls go through a gateway only on hosts listed for the gateway repo, and a call to a host listed for a component joins it whatever the host's labels say. Before, any unknown host whose path started with a gateway basepath was joined through the gateway, which invented interfaces. A scan note names each undeclared host that looks like a gateway.
- Merge never matches an endpoint of another method, and never joins a relative call on a generic path (`/health`, `/actuator/...`).

- A Spring path made from a constant (`@RequestMapping(ApiPaths.CARDS)`, `"/v2" + ApiPaths.CARDS`) is no longer a verified endpoint named `/ApiPaths.CARDS/...`: it is an `http-endpoint` loose end showing the name, `GET ${ApiPaths.CARDS}/${ApiPaths.BY_ID}`, until its value is known. Feign paths and listener topics made from constants show the name the same way, and stay loose ends.
- Merge never joins publishers and subscribers on a topic the code names but doesn't spell out.

### Scans that finish and say what they couldn't read

- The Java and Kotlin reader always moves on: a stray `}`, `)` or `]` inside an annotation (templates, archetypes, half-edited files) used to loop forever and stop the whole estate scan.
- A file over 5 MB (a committed `vendor.min.js`, a data dump) is left out of the scan with a warning. Before, it made the extractor that met it fail for the whole repo, losing everything else it had found there.
- `atticus scan` says how many warnings the scan had (files left out, rules that couldn't fill a template) and `--warnings` lists them; `--json` has them under `warnings`, and the scan's stats count them. Warnings don't fail the scan.

### Windows build and install

- `pnpm lint`, `pnpm licences`, `pnpm bundle` and `pnpm bundle:test` run on Windows: script paths come from `fileURLToPath`, the bundle imports through a file URL, and pnpm is started the way Windows needs. A new check in `pnpm lint` (`scripts/check-portable-paths.mjs`) refuses `URL.pathname` used as a file path and `import()` of a plain path.
- `install.ps1`: the `atticus.cmd` shim finds its version beside itself instead of holding a full path, so a profile folder with accented letters no longer breaks it; `-NoPath` leaves your PATH as it is.
- `pnpm bundle:test` installs into a home folder with a space and an accented letter, runs the `atticus` shim, no longer adds its throwaway folder to your PATH, and removes its temporary files when it passes. The bundle and licence check remove their `pnpm deploy` folder.
- The practice sandbox works on a machine with no Git identity (each repo gets a local one, with signing off), and its Git host is manual, so the product owner's lesson reaches Design with the command line alone: the hand-off PR steps are recorded with `atticus todo done`. Before, a fresh mock host in every command lost the PR.
- `atticus trace` no longer reports a test or plan twice when one worktree holds it with CRLF line endings (Git for Windows' `core.autocrlf`) and another with LF.
- Every package's tests run with their own temporary folder, removed when the run ends (`vitest.shared.mjs`); tests used to leave hundreds of folders behind in the system temp folder.
- CI runs the check on Linux and Windows on every push and pull request.
- The bundle leaves out `node_modules/.bin`, so a zip built on Windows holds the same files as one built on Linux.

## 1.0.0-rc.1 (2026-10-19)

The first release candidate: the whole product, built in five milestones.

### M5: ready to install

- `atticus doctor`: what this machine needs, each with a fix; first on the setup checklist and on Settings (ADR 0049).
- The local log (`.atticus/logs/`), redacted; crash messages that say where the details are; whole-file writes; one scan at a time; `atticus support bundle` (ADR 0050).
- `atticus upgrade` and `.atticus/metarepo.yaml`: migrations with backups, and an older Atticus refuses a metarepo a newer one upgraded (ADR 0051).
- The threat model; hardening headers on every response.
- The offline install bundle (`pnpm bundle`) with install scripts for Windows, macOS and Linux, checksums, a CycloneDX SBOM and third-party licences; the licence, dependency and docs checks in `pnpm lint` (ADR 0052).
- Performance budgets on 120 synthetic repos.
- Guides: install, admin, every role, troubleshooting, and the command reference.
- Fixed: the command line didn't declare `yaml`; shipped dialects were dropped outside the repository; `trace` cited tests in another task's worktree; `--port 0`.

### M4: the app

- The local API and all 27 screens in the HUD design, each with empty, loading and error states (ADRs 0015, 0043).
- A home and sidebar for each of thirteen roles, approvals from ownership only, first-run tours, guided setup and the catalog baseline (ADRs 0044, 0047).
- The command palette and Ask; system guides and the read-only catalog site; incident mode.
- Release views: deployment plan, forecast, evidence pack, release notes, outcome records and the security review draft (ADR 0045).
- AI on, text only or off (ADR 0046).
- Views across all changes, approvals waiting, the personal digest and the field-mapping grid (ADR 0048).
- The thirteen role journeys and an accessibility check of every screen in a browser.

### M3: changes from idea to release

- The change lifecycle across repos with hand-off PRs, separation of duties, risk and conflicts (ADR 0029); OpenSpec and Spec Kit as one framework (ADR 0030).
- The critic: rule layers, deterministic checks, AI lenses with evidence, rounds and gates (ADR 0034).
- Run with AI, assistant files for Copilot and Claude Code, planning, the story bar, manual adapters and executors (ADRs 0032, 0033, 0036, 0037).
- `init`, `adopt`, `absorb` and federation (ADR 0038); test generation, traceability, the CI drift check and the glossary (ADR 0039); features from code (ADR 0031); initiatives, learning, evals and defences (ADR 0042).

### M2: knowledge from documents

- Diagram and document ingestors, backend and platform extractors, intake and triage with curated decisions, knowledge sources, coverage and owner questions, stubs and diagram export, the dialect build kit (ADRs 0021 to 0028).

### M1: the catalog from code

- Built-in extractors and the dialect engine, merge and identity, the local index and query language, diagrams and reconcile (ADRs 0016 to 0020).

### M0: foundations

- The contracts C1 to C6, canonical YAML, the plugin SDK basics, the OpenSpec adapter, the workspace manager, adapters with mocks, the AI runtime and the OpenAPI document (ADRs 0001 to 0015).
