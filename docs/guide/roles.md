# Atticus for each role

Open the app with `atticus ui --open`. Your **view** (the role you work in) comes from your directory group, or you pick it in the sidebar; it decides your Home and the screens in your sidebar. Every screen stays under _All screens_, and Ctrl+K jumps anywhere. A three-step tour opens the first time you use a view; _Help_ in the top bar plays it again.

Two things are the same for everyone:

- **What you may approve comes from ownership, never from your view.** Hand-off PRs that wait on you (you, or a group you're in, is a reviewer) come first in _Waiting on you_ on Home, with a link to the PR. You approve in the Git host.
- **Ask in plain words.** The box at the top answers from the catalog, for example "who calls ledger-api?", and always shows the query it ran.

_Send it to me_ on Home sends you a digest of what waits on you through your organisation's notifications, when they are connected; Settings sets how often you want it.

## Product owner

**Your screens:** Home, Feature brief, Prototypes and UX, Changes, Breakdown, Initiatives, Ecosystem map, Knowledge explorer.
**Waits on you:** changes in Define, and blocking findings on the brief and proposal.

Start a change (`atticus change new "<title>" --type feature --by <you>`, or from Changes), write the brief: the problem, who it is for, how you'll know it worked. The business critic sits beside it with plain reasons and fixes. When nothing blocking is open, _Raise hand-off_ sends it to architecture; a person approves every hand-off. After release, record what the measures showed: `atticus outcome record <change> <measure> --value <v> --by <you>`.

## Business analyst

**Your screens:** Home, Breakdown, Feature brief, Changes, Test trace, Features, Knowledge explorer, Ecosystem map.
**Waits on you:** changes in Plan, and findings on stories and specs.

Breakdown shows the stories, the story bar they must meet and what no story covers yet. _Write stories with AI_ drafts them from the approved design (`atticus plan stories <change>`); with AI off you write them and the rule checks review them. Test trace follows every requirement to a story, a test and code.

## Architect

**Your screens:** Home, Architecture review, Diagrams, Reconcile, Contracts, Impact explorer, Ecosystem map, Org pack.
**Waits on you:** changes in Design, findings on design, interfaces and mappings, and diagram names and conflicts to decide in Intake.

Architecture review puts the design next to the integration patterns and what the code does; code wins over a diagram until a person decides. Reconcile compares each drawn edge with the code (`atticus reconcile`). At setup you walk the ecosystem map with the platform lead and accept the catalog.

## Team lead

**Your screens:** Home, Breakdown, Task board, Changes, Initiatives, Release plan, Impact explorer.
**Waits on you:** changes in Plan, and findings on tasks and service-desk drafts.

Breakdown and the Task board show tasks by repo in cross-repo order. _Changes > Across all changes > Tasks_ lists every open change's tasks in one place, with a filter. Initiatives shows who owes what against the target release (`atticus initiative status <id>`).

## Developer

**Your screens:** Home, Task board, Changes, Contracts, API mappings, Impact explorer, Knowledge explorer, To-do.
**Waits on you:** changes in Build.

`atticus workspace open <change> --repos <repos>` makes the change's worktrees and editor workspaces. _Run with AI_ on the Task board hands a task to your own assistant with the context it needs (`atticus task run <change> <task> --by <you>`); you review the diff, and Atticus never pushes to a protected branch. API mappings shows each hop's fields beside what the catalog maps today.

## QA / test

**Your screens:** Home, Test trace, Task board, Changes, Breakdown, Release plan, Features, Knowledge explorer.
**Waits on you:** changes in QA.

Test trace shows coverage, the gaps before sign-off and the test kinds this change needs (`atticus trace <change>`). `atticus tests generate <change> <story>` writes tests from a story. _Across all changes > Tests_ shows coverage for every open change.

## Delivery lead

**Your screens:** Home, Release plan, Service desk queue, Initiatives, To-do, Changes, Governance.
**Waits on you:** changes ready for release, and manual steps.

The Service desk queue holds the drafted requests with every field ready to copy; Atticus never files on its own, so filing makes a step a person does. The Release plan computes the deploy order, the forecast, the evidence pack, release notes and the security review draft, and asks for go / no-go (`atticus release plan <change>`).

## Platform lead

**Your screens:** Home, Scans, Intake, Org pack, Governance, AI quality, Settings, Learning.
**Waits on you:** items in Intake, owner questions and manual steps.

You run setup and keep Atticus healthy: see [the admin guide](admin.md). Settings shows _This machine_ (the same checks as `atticus doctor`).

## Designer / UX analyst

**Your screens:** Home, Prototypes and UX, Feature brief, Diagrams, Breakdown, Changes, Features.
**Waits on you:** changes in Define.

Prototypes and UX holds what Atticus reads from your designs and the requirements drafted from them.

## Process owner

**Your screens:** Home, Org pack, Service desk queue, To-do, Intake, Knowledge explorer, Learning.

The org pack holds your procedures and request templates; changes go in by pull request. `atticus templates draft` drafts templates from your wiki pages and past tickets, each value citing its source; you read `proposals/templates/SUMMARY.md` and accept what's right by pull request.

## DBA or data architect (optional role)

**Your screens:** Home, Contracts, API mappings, Impact explorer, Architecture review, Governance, Ecosystem map.

Contracts lists the data stores from DDL and migrations; pick a table to see its readers, writers and evidence. The Impact explorer follows a table or column to everything that depends on it (`atticus impact <id>`).

## SRE or operations (optional role)

**Your screens:** Home, Release plan, Impact explorer, Governance, Ecosystem map, To-do, Knowledge explorer.

Incident mode in the Impact explorer shows a failing system's blast radius, the owners to call and recent nearby changes, from the last scan. Atticus never connects to live systems. Governance compares callers' timeouts with what they call and shows what has no alert.

## Security reviewer (optional role)

**Your screens:** Home, Governance, Release plan, Contracts, Impact explorer, Architecture review, Ecosystem map.

Governance lists calls with no authentication declared and sensitive data by classification. Each change's Release plan carries a security review draft (`atticus release security <change>`).

## Learning

`atticus learn start <role>` runs a short lesson for a role in a practice sandbox (`atticus sandbox create <dir>`); the Learning screen tracks it. `atticus explain <id or command>` says what a record, finding, change or command means in plain words.
