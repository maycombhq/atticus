# 0120. A starter review every metarepo gets (C6 default, C3 rules)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-23
- Builds on: ADR 0115 (the critic's AI lenses review every draft), 0087 (the stages as loops), 0051 (`atticus upgrade`), 0111 (every finding quotes its line), 0074 (AI → deterministic → AI)

## Context

ADR 0115 made the critic's AI lenses review every draft a stage writes, with Copilot too. A lens runs only where the org pack has AI rules (`check: { type: ai, prompt }`) for that gate and lens. The built-in constitution has deterministic rules only, and a metarepo made by `atticus init` had no AI rules. So in practice no model reviewed a draft: the second AI pass was there, with nothing to judge.

## Decision

1. **A starter review in the org pack.** `atticus init` and `atticus adopt` write `org-pack/checklists/review.yaml` (pack `review`) with the other built-in defaults. It is the organisation's configuration, not the constitution: its rules are `layer: org`, its blocking rules are waivable, and an org changes, retires or deletes any rule, or deletes the file to turn the review off, through a pull request. The critic never loads the shipped copy itself, only the file in the org pack. `init --from <pack>` copies the org's pack as it is, without the starter review.
2. **Rules that judge meaning.** Ten AI rules, each with a plain-words prompt that asks a lens to judge the draft against the estate and the brief, and to quote the line it cites:
   - define (rules on the brief): business, every outcome the brief states is placed (blocking); architecture, a flow the change alters isn't marked only read (blocking), and a capability the brief assumes but nothing in the estate does is named as a gap (blocking).
   - design (rules on design, data and interfaces): architecture, every outcome has the target-flow steps that deliver it (blocking), data a step returns or shows comes from somewhere (blocking), a new column has its classification and migration, and the classification fits what it holds (blocking), and each hop's approved pattern fits what it does (risk).
   - plan (rules on stories and tasks): story, each outcome has a story (blocking), and each criterion is testable and names the data it checks (risk); delivery, requests and approvals are raised before the phase that needs them (risk).
3. **Gates from the artifacts, as C3 has it.** A C3 rule names no gate: it runs from the first gate where one of its artifacts is due, and again at each later gate. The default gates name no checklists, so every org checklist runs at every gate, and the change type's lenses decide the rest (a type that lists none uses every lens). So the define rules run again at design and plan, and a type without a brief (bug fix, configuration change, technical debt) gets no rule on the brief. The rules whose prompts need the brief say to report nothing when no brief is there.
4. **The brief rides with every lens in a stage review.** A lens reviews the draft against the brief (ADR 0115), so in a stage's review the change's brief joins the lens's documents when it is due and the lens's agent reads briefs, even when the lens's own rules read other artifacts (a story lens's rules read the stories). A plain `atticus critic` round is unchanged.
5. **`atticus upgrade` adds it once.** The migration `starter-review` writes `checklists/review.yaml` into an org pack with no AI review of its own, and the folder's README beside it when the README is still the one Atticus wrote, so every clone can tell. It does nothing when the pack has a `review.yaml` or a pack named `review`, when any checklist has an AI rule, when the metarepo's stamp records the step, or when the README names the starter review (the org deleted it). The files are backed up first, as every migration's are.

## Consequences

- A new metarepo's drafts are reviewed by a model before the next draft or the stage's PR, with Copilot or a model runtime. With the default feature type that is up to two lens prompts per draft at define, two at design and four at plan.
- No contract changes: the checklist is a C3 pack like any other and the org pack (C6) gains a default file, no schema version bump. The `review` pack name is taken by the starter review; an org that wants its own pack of that name writes it, and upgrade leaves it alone.
- Not built: rules tied to one gate only (C3 has no gate field; a rule repeats at later gates where its artifacts are still due), a business or delivery lens in the small-change type (its type lists neither, so the fast path gets the architecture and story rules only), and the brief in a plain `atticus critic` lens's documents.
