# Atticus by kind of work

Open the app with `atticus ui --open`. Everyone sees the same app, the same wherever it opens: a browser, the VS Code tab and IntelliJ's tool window (ADR 0119, ADR 0124 addendum D-app). The menu has six entries: **Home** (what needs you, then what is read and trusted and the changes in flight), **Map** (the estate canvas, flows, contracts, impact, trust), **Change** (all changes, one at a glance, then a tab per stage), **Questions**, **Knowledge** (items, sources, documents, search) and **Set up** (repos, AI, **Model runs**: what Atticus asked a model and what came back, and the org pack). Below them, **More pages** opens every other page, by section: the Map's older pages, a change's other pages by phase (the brief, the estimate, the task board, the release plan and the rest), Knowledge's and Set up's other pages, and Atticus's own (**Prompt history**, AI quality, learning). It stays open or closed as you left it. Each entry shows its pages as tabs above the page, with where you are; moving between a change's tabs keeps the change. One short tour (_Help_ in the top bar plays it again); Ctrl+K (Cmd+K on a Mac) opens any page by its name, and the menu says so under More pages. `atticus ui --full` makes every page a tab of its section and opens More pages. There are no roles or views to choose (ADR 0073); the sections below say which screens and commands each kind of work uses most.

Four things are the same for everyone:

- **You are your Git user.** Atticus records you as the metarepo's Git user (`git config user.name` and `user.email`), shown in the top bar. Commands that record a person use it; `--by <handle>` names someone else. If Git has no user on your machine, Atticus uses your OS user name and shows _Set your Git user_ until you run `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`.
- **Approving is the pull request.** Each phase ends with a hand-off PR in the metarepo; merging it approves the gate. Your Git host's rules (branch protection, CODEOWNERS) decide who may approve, and the person who raised a PR can't be its only approver. Home lists what needs a person (changes in each phase, blocking findings, questions, manual steps) and links to the change and its PR; there are no approve buttons in the app. Waivers, the catalog baseline and release go / no-go are files in the metarepo, recorded with your name, that reach main through a PR.
- **Run the steps in your assistant.** `atticus assistant-files` writes a slash command for each step into the metarepo (ADR 0086): `/atticus-next`, `/atticus-survey <repo>`, `/atticus-verify <repo>`, `/atticus-spec <repo>`, `/atticus-answer`, `/atticus-knowledge <source>`, `/atticus-find <phrase>`, `/atticus-knowledge-ask <question>`, `/atticus-feature <change>`, `/atticus-architecture <change>`, `/atticus-stories <change>`, `/atticus-small <change>` (a small change in one step), `/atticus-draft <change>`, `/atticus-needs <change>`, `/atticus-critic <change>`, `/atticus-attach <change> <files>` and `/atticus-task <change> <task>`, and for the catalog `/atticus-ask`, `/atticus-impact`, `/atticus-snow` and `/atticus-release`. The app's Help lists them all with what each does. Type one in Copilot Chat in VS Code or IntelliJ IDEA, or in Claude Code, where the Atticus plugin (ADR 0104) brings the same commands. The assistant does the AI work, and runs the `atticus` commands that check it. `atticus next` (or `/atticus-next`) says which step comes next and why. Where a slash command can't run, `atticus <step> --handoff` prints the prompt file, the result file and the commands that finish the step.
- **Ask in plain words.** The box at the top answers from the catalog, for example "who calls ledger-api?", and always shows the query it ran.

_Send it to me_ on Home sends you a digest (your hand-offs that came back with changes requested, and blocking findings on changes you are on) through your organisation's notifications, when they are connected; Settings sets how often you want it.

## Product owner

**Screens you use most:** Home, Feature brief, Prototypes and UX, Changes, Breakdown, Initiatives, Ecosystem map, Search the catalog.
**Watch for:** changes in Define, and blocking findings on the brief and proposal.

Start a change (`atticus change new "<title>" --type feature`, or from Changes), write the brief: the problem, who it is for, how you'll know it worked. The business critic sits beside it with plain reasons and fixes. When nothing blocking is open, _Raise hand-off_ sends it to architecture; merging its PR on the Git host approves it. After release, record what the measures showed: `atticus outcome record <change> <measure> --value <v>`.

## Business analyst

**Screens you use most:** Home, Breakdown, Feature brief, Changes, Test trace, Features, Search the catalog, Ecosystem map.
**Watch for:** changes in Plan, and findings on stories and specs.

Breakdown shows the stories, the story bar they must meet and what no story covers yet. _Write stories with AI_ drafts them from the approved design (`atticus stories <change>`); with AI off you write them and the rule checks review them. Test trace follows every requirement to a story, a test and code.

## Architect

**Screens you use most:** Home, Architecture review, Diagrams, Reconcile, Contracts, Impact explorer, Ecosystem map, Org pack.
**Watch for:** changes in Design, findings on design, interfaces and mappings, and diagram names and conflicts to decide in Intake.

Architecture review puts the design next to the integration patterns and what the code does; code wins over a diagram until a person decides. Reconcile compares each drawn edge with the code (`atticus reconcile`). At setup you walk the ecosystem map with the platform lead and accept the catalog.

## Team lead

**Screens you use most:** Home, Breakdown, Task board, Changes, Initiatives, Release plan, Impact explorer.
**Watch for:** changes in Plan, and findings on tasks and service-desk drafts.

Breakdown and the Task board show tasks by repo in cross-repo order. _Changes > Across all changes > Tasks_ lists every open change's tasks in one place, with a filter. Initiatives shows who owes what against the target release (`atticus initiative status <id>`).

## Developer

**Screens you use most:** Home, Task board, Changes, Contracts, API mappings, Impact explorer, Search the catalog, Manual steps.
**Watch for:** changes in Build.

`atticus workspace open <change> --repos <repos>` makes the change's worktrees and editor workspaces. _Run with AI_ on the Task board hands a task to your own assistant with the context it needs (`atticus task run <change> <task>`); you review the diff, and Atticus never pushes to a protected branch. API mappings shows each hop's fields beside what the catalog maps today.

## QA / test

**Screens you use most:** Home, Test trace, Task board, Changes, Breakdown, Release plan, Features, Search the catalog.
**Watch for:** changes in QA.

Test trace shows coverage, the gaps before sign-off and the test kinds this change needs (`atticus trace <change>`). `atticus tests generate <change> <story>` writes tests from a story. _Across all changes > Tests_ shows coverage for every open change.

## Delivery lead

**Screens you use most:** Home, Release plan, Service desk queue, Initiatives, Manual steps, Changes, Governance.
**Watch for:** changes ready for release, and manual steps.

The Service desk queue holds the drafted requests with every field ready to copy; Atticus never files on its own, so filing makes a step a person does. The Release plan computes the deploy order, the forecast, the evidence pack, release notes and the security review draft, and asks for go / no-go by raising the release hand-off PR; merging it is the go (`atticus release plan <change>`).

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
