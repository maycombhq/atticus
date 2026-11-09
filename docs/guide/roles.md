# Atticus by kind of work

Open the app with `atticus ui --open`. Everyone sees the same app, the same wherever it opens: a browser, the VS Code tab and IntelliJ's tool window (ADR 0119, ADR 0124 addendum D-app). The menu has six entries: **Home** (what needs you, then what is read and trusted and the changes in flight), **Map** (the estate canvas, flows, contracts, impact, trust), **Change** (all changes, one at a glance, then a tab per stage), **Questions**, **Knowledge** (items, sources, documents, search) and **Set up** (repos, AI, **Model runs**: what Atticus asked a model and what came back, and the org pack). Below them, **More pages** opens every other page, by section: the Map's older pages, a change's other pages by phase (the brief, the estimate, the task board, the release plan and the rest), Knowledge's and Set up's other pages, and Atticus's own (**Prompt history**, AI quality, learning). It stays open or closed as you left it. Each entry shows its pages as tabs above the page, with where you are; moving between a change's tabs keeps the change. One short tour (_Help_ in the top bar plays it again); Ctrl+K (Cmd+K on a Mac) opens any page by its name, and the menu says so under More pages. `atticus ui --full` makes every page a tab of its section and opens More pages. There are no roles or views to choose (ADR 0073); the sections below say which screens and commands each kind of work uses most.

Every picture (the estate canvas, Design, the knowledge graph, a change's diagram) takes the page's whole width and the height left on it, with details laid over its right edge rather than beside it, and opens fitted. Its toolbar zooms in and out, back to actual size, to fit and to the picked box; **Find a box** centres and picks a repo, system or topic by name; **Focus** dims everything but the picked box and what it links to; **Full screen** fills the window or the IDE panel (F, Esc to leave); while it is on, Tab and Shift+Tab stay inside the picture, leaving gives focus back to the Full screen button, and Esc in Find a box clears the search without leaving. The wheel or a pinch zooms and a drag pans; on the keyboard + and − zoom, 0 fits, 1 is actual size, the arrows pan, S zooms to the picked box, M focuses and / finds. A large picture has a minimap. On the estate canvas each event topic and MQ queue is a box of its own, publishers to the topic, the topic to its listeners, with who owns it, and marked **No listener in the estate** or **No publisher in the estate** when the estate has only one side of it. A topic or queue the profile names as another team's or a vendor's sits on that system, whichever way the estate's code uses it, and is marked **Declared in the profile** on its box, on its links and in Why is this linked?, with the profile's line: it rests on a person's word, not on code at both ends. A flow's sequence has Full screen too.

Four things are the same for everyone:

- **You are your Git user.** Atticus records you as the metarepo's Git user (`git config user.name` and `user.email`), shown in the top bar. Commands that record a person use it; `--by <handle>` names someone else. If Git has no user on your machine, Atticus uses your OS user name and shows _Set your Git user_ until you run `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`.
- **Questions come in the order to answer them, each with its owner.** `atticus questions list`, `atticus next` and the Questions page put first what a change in flight rests on (its own questions, and the link questions its critic findings name), then the answers that join the most calls (one answer to a group's question joins all its calls), so a lone `/ping` comes last. Each names the team that owns its repo (the manifest's `owner`); `--mine`, or _My teams'_ on the page, lists only your teams' when `roles.yaml` says who is on each (ADR 0140). A change's own questions go to the people its `change.yaml` names under `owners`, and are theirs under `--mine` (ADR 0153). Each question a change's phase raises also carries the role that owns it (ADR 0181): the brief's the product owner's, the design's the architect's, the stories' the business analyst's, the tasks' the tech lead's. The Questions page's **Role** filter lists one role's, and Home's **Your role's questions** shows yours for each change in flight, from the change's `owners` (or the role you pick there, remembered in your browser).
- **Answer once for many calls, or many questions at once (ADR 0153).** A target or hosts question takes a rule with its answer: `atticus questions answer <id> --option <n> --match "*.payments.forge.internal"` (a host pattern) or `--match "/forge/limits/**"` (a path prefix), or the rule field on the Questions page. The answer then covers every call that matches, the calls found later too, in the repos its scope allows (`--scope repo-type` for every repo of the type). A hosts answer's rule goes into the manifest: the pattern under the repo's `hosts`, or the prefix as its `basePath`, and the other open hosts questions it covers retire. `atticus questions sheet` writes every open question into one YAML file with an empty `answer:`; fill in what you know and run `atticus questions sheet --apply <file>`: each filled entry is answered as you, a blank one is skipped, and one whose question changed since is refused. An answer accepted from the assistant's proposal records that it was one, with the lines it cited, so a reviewer sees it was confirmed by a person.
- **Approving is the pull request.** Each phase ends with a hand-off PR in the metarepo; merging it approves the gate. Your Git host's rules (branch protection, CODEOWNERS) decide who may approve, and the person who raised a PR can't be its only approver. Home lists what needs a person (changes in each phase, blocking findings, questions, manual steps) and links to the change and its PR; there are no approve buttons in the app. Waivers, the catalog baseline and release go / no-go are files in the metarepo, recorded with your name, that reach main through a PR.
- **Run the steps in your assistant.** `atticus assistant-files` writes a slash command for each step into the metarepo (ADR 0086): `/atticus-next`, `/atticus-survey <repo>`, `/atticus-verify <repo>`, `/atticus-spec <repo>`, `/atticus-answer`, `/atticus-propose` (an answer proposed for each open question from the code, its lines checked, for you to accept with `atticus questions answer <id> --accept-proposal` or Accept on the Questions page, ADR 0144), `/atticus-knowledge <source>`, `/atticus-find <phrase>`, `/atticus-knowledge-ask <question>`, `/atticus-feature <change>`, `/atticus-architecture <change>`, `/atticus-stories <change>`, `/atticus-small <change>` (a small change in one step), `/atticus-draft <change>`, `/atticus-needs <change>`, `/atticus-critic <change>`, `/atticus-attach <change> <files>` and `/atticus-task <change> <task>`, and for the catalog `/atticus-ask`, `/atticus-impact`, `/atticus-snow` and `/atticus-release`. The app's Help lists them all with what each does. Type one in Copilot Chat in VS Code or IntelliJ IDEA, or in Claude Code, where the Atticus plugin (ADR 0104) brings the same commands. The assistant does the AI work, and runs the `atticus` commands that check it. `atticus next` (or `/atticus-next`) says which step comes next and why. Where a slash command can't run, `atticus <step> --handoff` prints the prompt file, the result file and the commands that finish the step.
- **Ask in plain words.** The box at the top answers from the catalog, for example "who calls ledger-api?", and always shows the query it ran. It answers from your organisation's knowledge too (ADR 0191): "How do I request a firewall rule?" shows the knowledge items and the passages of your wikis and inputs/ files that share its words, each quoted with its page, and the step that has your assistant word an answer from them (`atticus knowledge ask`).
- **A change goes product owner → architect → business analyst → tech lead (ADR 0191).** Each question says what it asks: business (the product owner's, or the business analyst's from the stories on), design (the architect's) or delivery (the tech lead's). The AI tags it when it raises it; if it went to the wrong person, _Send it to_ on the question (or `atticus questions route <id> --to product`) moves it. The change page lists who is on the change; where `roles.yaml` says who takes each role (a team's `roles`, the file's `defaults`, version 3), it suggests them and **Accept** names them in one click. Each hand-off is reviewed by the next role (the architect reviews the brief, the business analyst the design, the tech lead the plan), who are told through your notifications, and At a glance says whom the change waits on ("Waits on: @ari (architect)").

_Send it to me_ on Home sends you a digest (your hand-offs that came back with changes requested, and blocking findings on changes you are on) through your organisation's notifications, when they are connected; Settings sets how often you want it.

## Product owner

**Screens you use most:** Home, Brief, Prototypes and UX, Changes, Breakdown, Initiatives, Ecosystem map, Search the catalog.
**Watch for:** changes in Define, and blocking findings on the brief and proposal.

Home shows you **Your changes** with whom each waits on, your questions and only the business findings; setting Atticus up is folded under _Setting up Atticus_ (ADR 0191). A design finding (a circuit breaker, an alert) waits for the architect and never holds your brief. Start a change (`atticus change new "<title>" --type feature`, or from Changes), accept the owners Atticus suggests, then write the brief on its **Brief** tab: one box per part (the problem, who it is for, how you'll know it worked), each with a hint of what goes there; Save writes the change's brief.md. The business critic sits beside it with plain reasons and fixes. When nothing blocking is open, _Raise hand-off_ sends it to architecture; merging its PR on the Git host approves it. After release, record what the measures showed in the Release plan's _Outcomes_ panel (choose the measure, say what you measured, _Record_), then _Propose for review_ (or `atticus outcome record <change> <measure> --value <v>`).

## Business analyst

**Screens you use most:** Home, Breakdown, Feature brief, Changes, Test trace, Features, Search the catalog, Ecosystem map.
**Watch for:** changes in Plan, and findings on stories and specs.

On the **Stories** tab you shape the stories in your own words (ADR 0191): rename one, split one into two, merge stories of one repo, or add one. A rename keeps the story's number, a split's new part and an added story take the next free one. The next draft of the stories puts each task under the story it belongs to, and the check says what is left uncovered (a story with no task). The same tab puts each story with its tasks into the work tracker: with Azure DevOps set up as manual, each is a step on Home with the fields to copy (title, description, acceptance criteria, parent) and the place to record the id it got; a later update changes those items, it never makes second ones.

Breakdown shows the stories, how ready each is and what no story covers yet. _Write stories with AI_ drafts them from the approved design (`atticus stories <change>`); with AI off you write them and the rule checks review them. Test trace follows every requirement to a story, a test and code.

## Architect

**Screens you use most:** Home, Architecture review, Diagrams, Reconcile, Contracts, Impact explorer, Ecosystem map, Org pack.
**Watch for:** changes in Design, findings on design, interfaces and mappings, and diagram names and conflicts to decide in Intake.

Architecture review puts the design next to the integration patterns and what the code does; code wins over a diagram until a person decides. Reconcile compares each drawn edge with the code (`atticus reconcile`). At setup you walk the ecosystem map with the platform lead and accept the catalog.

## Team lead

**Screens you use most:** Home, Breakdown, Task board, Changes, Initiatives, Release plan, Impact explorer.
**Watch for:** changes in Plan, and findings on tasks and service-desk drafts.

Breakdown and the Task board show tasks by repo in cross-repo order. The tech lead or architect runs the tasks: **Run all ready tasks** on the Task board runs every task whose dependencies are done, in cross-repo order, one task run each, and stops on the first that needs a person (`atticus task run-ready <change>`; `--level pr --approve` raises each PR into the change branch). Each task ends on its own `task/<change>/<task>` branch; nothing is merged, and a person reviews and merges each PR on the Git host (ADR 0181). _Changes > Across all changes > Tasks_ lists every open change's tasks in one place, with a filter. Initiatives shows who owes what against the target release (`atticus initiative status <id>`). When a team or vendor tells you where their part stands, choose _Update_ on the commitment, set it to open, at risk, done or slipped with a note of what they said, and _Propose for review_ (or `atticus initiative commit <commitment> <state> --note "<what changed>"`).

## Developer

**Screens you use most:** Home, Task board, Changes, Contracts, API mappings, Impact explorer, Search the catalog, Manual steps.
**Watch for:** changes in Build.

`atticus workspace open <change> --repos <repos>` makes the change's worktrees and editor workspaces. The tech lead or architect runs the tasks: _Run with AI_ on the Task board hands one task to the assistant with the context it needs (`atticus task run <change> <task>`), and _Run all ready tasks_ runs every ready one; you review each PR's diff, and Atticus never pushes to a protected branch. API mappings shows each hop's fields beside what the catalog maps today.

## QA / test

**Screens you use most:** Home, Test trace, Task board, Changes, Breakdown, Release plan, Features, Search the catalog.
**Watch for:** changes in QA.

Test trace shows coverage, the gaps before sign-off and the test kinds this change needs (`atticus trace <change>`). `atticus tests generate <change> <story>` writes tests from a story. _Across all changes > Tests_ shows coverage for every open change.

## Delivery lead

**Screens you use most:** Home, Release plan, Service desk queue, Initiatives, Manual steps, Changes, Governance.
**Watch for:** changes ready for release, and manual steps.

The Service desk queue holds the drafted requests with every field ready to copy. A missing field is filled on the page: it is written into the change's `snow.md` (refused if the file changed since the page read it), then **Propose for review** opens a PR for it. Atticus never files on its own, so filing makes a step a person does. The Release plan computes the deploy order, the forecast, the evidence pack, release notes and the security review draft, and asks for go / no-go by raising the release hand-off PR; merging it is the go (`atticus release plan <change>`). Before go / no-go, **Raise the release PRs** opens one PR per code repo from the change branch into its default branch (`atticus change release-prs <change> --approve`, ADR 0184). A person merges each on the Git host, and Sync records it. Go / no-go and the archive wait for them. After they merge, read each repo again at the merged commit (Map › Trust › Freshness), so the archive compares the catalog with what shipped.

Start an initiative for a release that needs several teams or vendors on Initiatives: _New initiative_ takes the title, the guided journey and the target release; _Plan it_ names the system it is about and works back from the release to the changes to start and who owes what by when. Record each commitment as it moves (_Update_: open, at risk, done or slipped, with a note). After each save, _Propose for review_ opens the pull request with the initiative's files; a person merges it. The commands do the same: `atticus initiative new "<title>" --journey <j>`, `atticus initiative plan <id> --target <system>` and `atticus initiative commit <commitment> <state>`.

## Platform lead

**Screens you use most:** Home, Scans, Intake, Org pack, Governance, AI quality, Settings, Learning.
**Watch for:** items in Intake, owner questions and manual steps.

You run setup and keep Atticus healthy: see [the admin guide](admin.md). Settings shows _This machine_ (the same checks as `atticus doctor`).

## Designer / UX analyst

**Screens you use most:** Home, Prototypes and UX, Feature brief, Diagrams, Breakdown, Changes, Features.
**Watch for:** changes in Define.

Prototypes and UX holds what Atticus reads from your designs and the requirements drafted from them.

## Process owner

**Screens you use most:** Home, Org pack, Service desk queue, Manual steps, Intake, Search the catalog, Learning.

The org pack holds your procedures and request templates; changes go in by pull request. `atticus templates draft` drafts templates from your wiki pages and past tickets, each value citing its source; you read `proposals/templates/SUMMARY.md` and accept what's right by pull request.

## DBA or data architect

**Screens you use most:** Home, Contracts, API mappings, Impact explorer, Architecture review, Governance, Ecosystem map.

Contracts lists the data stores from DDL and migrations; pick a table to see its readers, writers and evidence. The Impact explorer follows a table or column to everything that depends on it (`atticus impact <id>`).

## SRE or operations

**Screens you use most:** Home, Release plan, Impact explorer, Governance, Ecosystem map, Manual steps, Search the catalog.

Incident mode in the Impact explorer shows a failing system's blast radius, the owners to call and recent nearby changes, from the last scan. Atticus never connects to live systems. Governance compares callers' timeouts with what they call and shows what has no alert.

## Security reviewer

**Screens you use most:** Home, Governance, Release plan, Contracts, Impact explorer, Architecture review, Ecosystem map.

Governance lists calls with no authentication declared and sensitive data by classification. Each change's Release plan carries a security review draft (`atticus release security <change>`).

## Learning

`atticus learn start <lesson>` runs a short lesson (each is written for a kind of work, such as product owner) in a practice sandbox (`atticus sandbox create <dir>`); the Learning screen tracks it. Start with `atticus learn start everyone`, "Your first hour": see what comes next, read a change at a glance, ask the catalog, watch a change and learn how approving works; each step checks it was done. `atticus explain <id, command or word>` says what a record, finding, change, command or one of Atticus's own words means in plain words; the app's **What the words mean** lists the words.
