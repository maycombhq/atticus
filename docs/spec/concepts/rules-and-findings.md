# Rules and findings

Each phase of a change ends at a gate. A gate runs checklist packs: sets of rules over the
change's artifacts and the catalog ([C3: Rules and findings](../contracts/c3-rules-and-findings.md)).

## Rules

A rule is either deterministic (a named check with parameters, run the same way every time) or
an AI check bounded by evidence: it must cite the artifact or record it relies on, and a finding
without evidence is dropped. Rules come in layers: a built-in constitution, the organisation's
rules and a team's rules. A lower layer can add or tighten rules but never loosen a higher one,
and constitution rules can't be waived.

## Findings

A finding is one result of a rule on one change, stored as
`openspec/changes/<change>/review/<gate>/<round>/<finding-id>.yaml`. Its severity decides what
it does:

- `blocking`: stops the hand-off until fixed, or waived by the stage owner with a reason;
- `gap`: needs a fix or a recorded reason;
- `risk` and `idea`: recorded, never blocking.

A finding moves through states (`open`, `applied`, `dismissed`, `waived`, `asked`) by people's
actions, each recorded with who and why. A gate runs at most a set number of rounds with the
authoring agent before a person decides.

## Knowledge gaps

When a rule needs a fact the catalog doesn't have (a timeout, an owner, a classification), the
finding says which fact is missing and who could supply it, instead of guessing.
