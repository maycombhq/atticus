# 0044. Generated release views and outcome records (C4, additive)

- Status: accepted
- Date: 2026-10-18

## Context

The plan says the release plan, evidence pack, security review draft and test trace are generated views of a change, not artifacts, so they never go stale. The test trace existed (`atticus trace`, ADR 0039). The rest were missing, and the brief's success measures had nowhere to be recorded once the change shipped.

## Decision

- **A new core package, `@maycombhq/release`**, computes the views from files on every read: the change folder, the catalog, the org pack, `repos.yaml`, manual steps and critic rounds. No network, no AI, no file it writes except the outcome records below. It is a core package for the neutrality check (ADR 0035).
  - **Deployment plan**: a deploy order across the change's repos from dependencies (a gateway route before its caller, a topic before its publisher, a migration before the code that reads the table, a callee before its caller for a new or changed interface, a story's repos after those of the stories it depends on). Each step says why it sits there, its rollback from design.md or data.md (or the gap "no rollback step written"), and the service requests it waits on with a forecast wait in working days (template lead times, or past requests when exported). Rollout, rollback, readiness, verification and hypercare come from design.md headings or are listed as gaps. The critic's release lens is not re-run: its open findings are shown.
  - **Forecast**: the earliest ready-to-release day from those lead times, and, when the change belongs to an initiative with a plan, that plan's projected finish and due date for its release milestone (the initiatives package's critical path). Open tasks carry no estimates, so they are counted, not guessed.
  - **Evidence pack**: one Markdown document (change summary, every file with its sha-256 checked against the hand-offs, critic rounds and resolutions, waivers, approvals, trace, requests and steps, drift, AI run summaries, outcomes), each item naming its source file. `atticus release evidence --out <dir>` also writes `manifest.json` and a copy of every file.
  - **Release notes**: for business or technical readers, from the brief and proposal, interfaces.md (breaking yes, no, or "check" with the reason), data.md and waived findings.
  - **Security review draft**: auth per new or changed interface (catalog, notes or gateway policies; "not stated" otherwise), classification of each new field (org-pack levels; "not classified yet" when untagged), data crossing a system boundary from mappings.md, vendors, credentials and secrets the calls need or the documents name, open security-relevant findings, and the sign-off: the security reviewer when roles.yaml enables that role, else the architect, through the existing hand-off PR of the gate that role approves. There is no new approval path.
- **C4 workspace file: `openspec/changes/<id>/review/outcomes.yaml`** (`ChangeOutcomes` in core, JSON Schema `workspace/v1/ChangeOutcomes.json`). It keeps only what people recorded: per measure (a slug of the brief's words) the measure's words when first recorded and a list of values, each with `value`, `by`, `at` and an optional `note`. The measures themselves are read from the brief's "Success measures" section on every view, so a reworded brief shows old values as orphans rather than losing them. Values can be recorded once the change is released (`released`, `post-release-review` or `archived`); before that the command refuses in words. The file sits under `review/` beside the critic's rounds; it is a file, not a gate folder, so the critic never reads it as a round.
- **Commands**: `atticus release plan|forecast|evidence|notes|security <change>` (each with `--json`), `atticus outcome list [--change]` and `atticus outcome record <change> <measure> --value <v> --by <you> [--note]`. Exit 0 with gaps said in words, 1 refused (no such change, a value before release), 2 usage.
- **Local API**: the calls are listed in ADR 0043 under "Release and Run screens"; recording an outcome takes `RecordOutcomeRequest` and records it as the signed-in person.

## Consequences

The Release screen shows the plan, forecast, release sections, security draft, notes, outcomes and an evidence export, all from the same functions as the terminal. A change folder may now hold `review/outcomes.yaml`; tools that list review folders already skip files. Nothing existing changed shape, so no migration is needed.
