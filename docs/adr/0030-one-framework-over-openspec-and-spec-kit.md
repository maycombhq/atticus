# 0030. One framework: OpenSpec for the change, Spec Kit inside each repo

- Status: accepted (direction from the product owner, 2026-10-18); built in M3
- Date: 2026-10-18

## Context

Both OpenSpec and GitHub Spec Kit are available to teams in the target organisation. Each is strongest at a different level. OpenSpec: change folders with spec deltas, archive into living specs, custom workflow schemas and a machine-readable CLI (ADR 0006, 0008), which suit a change that spans many repos and needs governance. Spec Kit: a constitution, an assistant-native command flow (`/speckit.specify`, `clarify`, `plan`, `tasks`, `analyze`, `checklist`, `implement`), plan-time artifacts (`research.md`, `data-model.md`, `contracts/`, `quickstart.md`) and first-class Copilot integration, which suit a developer implementing work in one repo.

## Decision

Atticus is one framework with two levels.

1. **The change level: OpenSpec plus Atticus, in the metarepo.** The whole change lives in `openspec/changes/<id>/` with the org-flow schema: brief, proposal, specs, interfaces, mappings, data, design, stories, tasks and SNOW drafts, plus Atticus's `change.yaml`, `review/` and `repos.yaml`. The critic, approvals, hand-off PRs and audit trail work here, and OpenSpec archives each change into the living specs.

2. **Hand-down at Build.** When a task starts, Atticus creates a Spec Kit feature in the target code repo, on the change's branch: `specs/<task-id>/spec.md` from the story and its acceptance criteria, and a seeded `plan.md` (with `data-model.md` and `contracts/` where the change has them) from the design, interfaces, mappings and data that concern that repo. The repo's `.specify/memory/constitution.md` is generated from the org pack's constitution, the same source as the critic's constitution layer. Spec Kit's own templates and commands are installed in the repo through the skill source (M3 track D), next to `/atticus-*` commands.

3. **Execution: Spec Kit inside the repo.** A developer runs `/speckit.clarify`, `/speckit.plan`, `/speckit.tasks` and `/speckit.implement` in Copilot or Claude Code; or Run with AI drives the same steps at plan-only, draft or PR level. Questions that need the change level (a new interface, another system) go back up as owner questions or a request to amend the design, never as a silent edit.

4. **Hand-up at the PR.** When the repo's PR is raised, Atticus reads the Spec Kit feature back: the task is marked done with `plan.md` and `tasks.md` attached as evidence, the critic's code-and-test lens reviews them, and a drift check compares the repo plan with the change's design (new interfaces, changed data, systems not in the design). Drift warns; a contradiction with the approved design blocks until the design is amended or the plan is fixed. After merge the scan updates the catalog.

5. **Configuration.** The org pack sets the build engine for code repos: `speckit` (default) or `atticus` (plain Atticus task files, for repos that don't use Spec Kit). The change level is always OpenSpec. A team that also wants Spec Kit at the change level is out of scope for 1.0; it would need a second change-level engine behind the same adapter. This is an additive optional field in C6 (no schema version bump).

## Consequences

Each tool does what it is best at, and no artifact exists in both formats at the same level: there is one hand-down and one hand-up to maintain instead of a two-way mapping everywhere. Governance stays in one format for architects and approvers; developers keep Spec Kit's commands and Copilot integration in their repos. Costs: a Spec Kit adapter with contract tests against a pinned Spec Kit version, and the drift check between repo plans and the change design. `absorb` remains the one-off import of an existing Spec Kit repo's constitution, specs and prompts.
