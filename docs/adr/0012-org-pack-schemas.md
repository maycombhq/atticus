# 0012. Contract C6: org-pack schemas

- Status: accepted
- Date: 2026-10-18

## Decision

Everything about how an organisation, platform or team works lives in `org-pack/` as files with a zod schema and generated JSON Schema, changed through reviewed PRs.

| File                               | What it holds                                                                                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pack.yaml`                        | Name, version, the one named owner, review window (default 90 days), freshness window per record kind, classification levels                                                                             |
| `roles.yaml`                       | Custom roles (each based on a built-in view), optional roles in use, group-to-view mappings, approvers for actions outside Git, separation-of-duties pairs                                               |
| `change-types.yaml`                | Each type's phases (in canonical order), required artifacts, lenses, approvals per phase, and whether it is reviewed after release                                                                       |
| `gates.yaml`                       | Per gate: phase, approver roles, minimum approvals, checklist packs, measurable checks, author rounds before a person decides (default 2)                                                                |
| `patterns/<code>.yaml`             | One integration pattern: definition, interaction, route, target type, controls, default resilience, technology, detection hints, checklist rules it adds, source, version, status                        |
| `sources.yaml`                     | Adopt-in-place layout, read-only wikis, absorbed repos (adopt, link or ignore)                                                                                                                           |
| `runtime.yaml`                     | Allowed assistants, editors and AI modes; models; autonomy default and per-repo caps; fix rounds; token budgets; run retention (default 30 days); telemetry (off by default); adapter types and settings |
| `process/skills/<id>/SKILL.md`     | YAML front matter (who it applies to, owner, source, status) and the instructions                                                                                                                        |
| `process/snow/<id>.yaml`           | A service-desk request template: fields filled from the change, approvers, lead time, the catalog changes that trigger it, related templates                                                             |
| `test-strategy.yaml`               | Required test types per change type and risk; definition of ready                                                                                                                                        |
| `profiles/<platform>/profile.yaml` | Systems with boundaries and aliases, environments, diagram legend, mandatory gates (beside `repos.manifest.yaml`)                                                                                        |

- **Works before it's configured.** Every file is optional. Thirteen built-in roles, six change types, a gate per phase, a runtime policy, sources and a test strategy apply until a team writes its own file, which replaces that default as a whole.
- **One validation pass.** `loadOrgPack` reads the whole pack (C6 plus dialects under C2 and checklists under C3), never stops at the first problem, and checks references across files: roles in gates and change types, checklist packs in gates, rules in patterns, gates in profiles, dialects in manifests and in `extends`, change types in the test strategy, related request templates, repo types in skills. `atticus orgpack validate` prints every problem with its file.
- **No secrets.** Adapter settings whose names look like tokens, passwords or keys are refused; secrets come from the credential store.
- **Approval rights come from ownership,** never from the view a person picks.

## Consequences

An org pack can be checked in CI before anyone uses it, and a broken pack is reported in one go.
