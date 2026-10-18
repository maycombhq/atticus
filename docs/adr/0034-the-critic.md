# 0034. The critic

- Status: accepted
- Date: 2026-10-18

## Decision

The critic (`@maycombhq/naysayer`) reviews a change at a gate in two layers.

**Layer 1** is deterministic and costs no tokens: built-in checks named by C3 rules read the change folder, the catalog and the org pack (21 checks, extensible by plugins), and each rule's `needs` turn missing or stale facts into knowledge gaps with owner questions, so no rule passes silently. Findings carry line evidence with quotes and catalog records; findings about the same problem from overlapping rules merge, keeping the strictest rule; mechanical fixes carry a patch.

**Layer 2** runs one AI lens per lens (business, architecture, story, UX, delivery, code and test, release) in a fresh session, using a different model family from the author's when `runtime.yaml` allows, and only over artifacts with no blocking layer-1 finding. Ingested text is wrapped as data. AI output is kept only when it names a rule it was asked to apply, an artifact it was given, and a quote that really appears on that line; severity, layer and state always come from the rule.

**Rules layer** as the built-in constitution (13 rules kept as data, never waivable), then the org packs the gate names (plus rules a chosen pattern adds), then team packs at `org-pack/teams/<team>/checklists/` for the teams owning touched systems. Teams may add rules or tighten them (same check and lens, at least as strict, same needs, not waivable if the base isn't) but never drop or loosen one; a pack that tries is refused whole and reported.

**Rounds and gates**: findings are C3 files in `review/<gate>/<round>/`; at most two author rounds run per gate (configurable down), then a person decides. Gate status is read the same way as the lifecycle's hand-off check (ADR 0029). Actions enforce C3's state rules: apply and edit-and-apply touch only the finding's artifact and refuse if it changed meanwhile; not-relevant needs a reason; waive is for blocking findings, by the stage owner, never for constitution findings; knowledge gaps take ask or edit-and-apply. Dismissed or waived problems stay so when they recur. **Override rates** per rule produce a suggested checklist patch after repeated dismissals with the same reason; it is never applied automatically.

## Consequences

Everything that can be checked deterministically is caught for free and reproducibly; AI answers are bounded by evidence. On the hand-written M3 exit fixture (`fixtures/forge-change/`), the critic catches all 14 seeded blocking issues and 13 of 13 seeded gaps with no unlisted findings, and the test reports which layer caught each. Candidate additive contract changes: C3 `RuleNeed.where` and `scope: touched-vendors`, C3 `Finding.source`, C6 team-pack location, and reconciling C6 `roles.yaml approvals.waiver` with the stage-owner rule.
