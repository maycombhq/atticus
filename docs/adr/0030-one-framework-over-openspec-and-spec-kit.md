# 0030. One framework over OpenSpec and Spec Kit

- Status: accepted (direction from the product owner, 2026-10-18); built in M3
- Date: 2026-10-18

## Context

Both OpenSpec and GitHub Spec Kit are available to teams in the target organisation. Teams should not have to pick a side, and Atticus should take the strengths of both: OpenSpec's change folders with spec deltas, archive into living specs, custom workflow schemas and a machine-readable CLI (ADR 0006, 0008); Spec Kit's constitution, its assistant-native command flow (`/speckit.specify`, `clarify`, `plan`, `tasks`, `analyze`, `checklist`, `implement`), its plan-time artifacts (`research.md`, `data-model.md`, `contracts/`, `quickstart.md`) and its first-class Copilot integration.

## Decision

Atticus becomes one framework with two storage engines behind one interface.

1. **One workflow, a superset of both.** The org-flow phases stay (Define, Design, Plan, Build, Release), and Spec Kit's steps map onto them:

   | Spec Kit step                                      | Atticus                                                                                                                                |
   | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
   | constitution                                       | the constitution layer of the critic; one source in the org pack generates both the critic rules and `.specify/memory/constitution.md` |
   | specify                                            | brief → proposal and specs (Define)                                                                                                    |
   | clarify                                            | open questions answered before Design; unanswered ones become owner questions                                                          |
   | plan (research, data-model, contracts, quickstart) | design, interfaces, mappings and data (Design)                                                                                         |
   | tasks                                              | stories and tasks (Plan)                                                                                                               |
   | analyze, checklist                                 | the critic: layer 1 consistency checks and checklist packs                                                                             |
   | implement                                          | Run with AI (plan only, draft, PR)                                                                                                     |
   | — (OpenSpec)                                       | spec deltas, archive into living specs                                                                                                 |
   | — (Atticus)                                        | catalog, reconcile, ServiceNow drafts, hand-off PRs, approvals                                                                         |

2. **Two engines behind a `SpecEngine` adapter (C4).** `openspec`: `openspec/changes/<id>/`, the org-flow schema, the stable CLI. `speckit`: `specs/<feature>/` (spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md, tasks.md, checklists/) and `.specify/`. Both expose the same operations to Atticus: create a change, list artifacts and their status, read and write an artifact, validate, and finish (archive or fold into living specs). Each artifact maps both ways, so a change can be read by the critic, approvals and the UI whichever engine stores it. Atticus's own files (`change.yaml`, `review/`, `repos.yaml`) sit beside the engine's files.

3. **Choice by configuration.** The org pack names the engines a platform allows and its default, and a team or repo may choose another allowed engine. This is an additive optional field in C6 (no schema version bump); until it lands, the default stays `openspec`.

4. **Assistant commands for both.** The skill source (M3 track D) generates Spec Kit-compatible `/speckit.*` commands and Atticus's `/atticus-*` commands for Copilot and Claude Code, so a developer used to Spec Kit keeps the same commands, and Atticus still runs its gates, critic and approvals behind them.

5. **Living specs for both.** On release, OpenSpec archives deltas into `openspec/specs/`; for a Spec Kit feature, Atticus folds the feature spec into the same living capability specs, so the as-is specification is one place whichever engine a team used.

## Consequences

Teams on either tool get the same catalog, critic, approvals and audit trail; the organisation standardises the governance, not the tool. Cost: a second engine adapter with contract tests against a pinned Spec Kit version, and two-way artifact mapping to maintain. `absorb` (M3) becomes a one-off import of a Spec Kit repo, while ongoing Spec Kit work runs through the engine.
