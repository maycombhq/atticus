# 0059. Onboarding: the organisation's assistant drafts the dialect, checks decide

- Status: accepted (pending review by the product owner)
- Date: 2026-10-19

## Context

Atticus must read any ecosystem: any gateway, framework, infra or pipeline layout, house or vendor. Building a reader per technology never catches up, and a bank's estate is mostly technology we have never seen. Rules (C2 dialects, ADR 0056 and 0058; framework models, ADR 0054 and 0055) can express what those readers would do, and the dialect kit lets an assistant write them, but only by hand-over: someone exports the kit, gives it to an assistant, and brings the file back. Nothing told anyone which repos needed it.

## Decision

**`atticus onboard <repo>`** runs the loop:

1. **Survey**, deterministically: the repo's files by extension, what the built-in extractors and current dialects already read, and excerpts of the structured files no record cites.
2. **Draft**: the `dialect-drafter` agent (the org pack's, or a built-in default; C5 unchanged) gets the dialect kit (reference, checklist, record kinds, the three gateway dialects of ADR 0058 as worked examples) as instructions, and the survey and excerpts as data (`<atticus-data>`, screened by the C5 defences). It replies with a dialect.
3. **Check**, deterministically: valid C2; the name asked for; no `extends`, no `plugin`; its own tests pass and exercise every rule (ADR 0056); run on the repo it produces records and none is invalid.
4. **Hand back**: a failed draft and the list of what failed go to the next attempt, as data, up to `--attempts` (default 3).
5. **Propose**: a passing draft is written to `proposals/dialects/<name>.yaml`. Nothing scans with a proposal.
6. **Accept**: `atticus onboard accept <name>` is a person's approval: the proposal's tests must still pass, and it moves to `org-pack/dialects/`. The org pack is committed and reviewed as any change to it. `atticus onboard check <name> --repo <repo>` runs the same checks on a draft written by hand or through a hand-off.

The model is whatever `runtime.yaml` allows (`model` with the organisation's provider, `headless-claude-code`, `replay`; `hand-off` hands the task to the person's assistant). Tests use a mock or replay runtime; nothing calls a network in a test.

**The scan says which repos to onboard.** Coverage gains, per repo, the structured files no record cites, and `needsOnboarding` when nothing was read beyond the repo's component though it has such files. `atticus scan` names those repos and the command to run.

**The scan says which rules to re-draft.** A dialect that a repo's manifest entry names is listed for re-drafting when its own tests fail (the scan leaves it out) or when it reads nothing in that repo; `atticus onboard <repo> --name <dialect>` drafts its replacement and `onboard accept --replace` takes it. Dialects that apply by repo type alone aren't listed: reading nothing where a framework isn't used is expected.

**Scans stay deterministic.** The assistant writes rules; rules make records. No AI runs inside a scan (rule 4), every record keeps its evidence, and a rule an assistant wrote is used only after its checks pass and a person accepts it (rule 6).

## Consequences

- A repo on technology Atticus has never seen is one command and a review away from being read, instead of a code change.
- The quality of a draft is measured, not trusted: the checks are the same for every draft, and the gateway dialects are the reference to grade drafts against. Grading real models across ecosystems needs those models, so it runs where they are (the organisation's runtime), not in CI.
- Framework models (code repos, ADR 0055) are drafted with `atticus frameworks kit` for now; the same loop for them is a follow-up.
- What no repo holds (a vault, a config server) no draft can read; the survey and hand-over say so.
