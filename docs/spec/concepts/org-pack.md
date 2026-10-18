# The org pack

Everything an organisation configures lives in one folder of files, the org pack
([C6: The org pack](../contracts/c6-org-pack.md)). Anything an organisation might need to change
is configuration, a rule file or a plugin; nothing needs a code change.

## What it holds

- `pack.yaml`: the pack's name, version, owner, review window and classification levels;
- `roles.yaml`: the roles and who plays them;
- `change-types.yaml`: kinds of change, their phases, artifacts and approvals;
- `gates.yaml`: a gate per phase: approvers, checklist packs and measurable checks;
- `patterns/`: integration patterns and how to detect them on an interaction;
- `sources.yaml`: knowledge sources and the folder layout;
- `runtime.yaml`: which adapter serves each external system type, and the AI runtime;
- `dialects/` and `checklists/`: rule files (C2 and C3);
- `process/`: procedures with their steps, request templates and skills;
- `agents/`: agent definitions (C5);
- `test-strategy.yaml`: which tests each type of change needs;
- `profiles/<profile>/`: an ecosystem profile and its repository manifest.

## Validation

A pack is validated file by file against its schema and across files: every role a gate or
change type names exists, every checklist a gate runs exists, every dialect a repository lists
exists, and so on. All problems are reported at once, each with its file and field. Files the pack
leaves out fall back to built-in defaults, and the defaults used are listed.

## Not configurable

Some rules are not configuration: a person approves every write to a shared system; AI never
pushes to protected branches or deploys; every fact keeps its provenance; constitution rules
can't be waived; ingested content is data, never instructions.
