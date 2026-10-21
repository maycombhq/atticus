# 0070. A change's proposal and spec are drafted from its brief and the map

- Status: accepted (pending review by the product owner)
- Date: 2026-10-20

## Context

Atticus scans an estate into a catalog and runs changes through OpenSpec, but the step between was left to the person's assistant: turning a brief into a proposal, a spec delta and the interfaces it changes. The assistant did that without the catalog, and the critic found its mistakes afterwards. Stories could only be planned once the design had passed its approvals, so a team couldn't see the stories a design implies while still shaping it.

## Decision

**`atticus change draft <change>`.** From the brief, Atticus picks the part of the catalog the change is about, without AI: features, endpoints and tables whose names share the brief's words (weighted by how rare a word is in the estate, the title's words three times the body's), ids the brief names, then the components serving those endpoints, the calls into them, the tables' readers and writers, and their systems. The organisation's assistant gets the brief and that map as data (agent `change-drafter`, built in or the org pack's) and answers with `proposal.md`, `specs/<capability>/spec.md` and, when calls or endpoints change, `interfaces.md`. Before anything is written the draft is checked: the proposal has Why and What Changes; every spec has a delta heading and every requirement a scenario with WHEN and THEN; every system, caller, callee and interface id is in the catalog or marked new; operations and statuses are well formed. Problems go back for another attempt (`--attempts`, default 3). Files a person wrote are kept unless `--force`; only the change's design files can be written. Hand-off mode works as elsewhere: `handoff done`, then `change draft --resume`.

**`atticus plan stories --draft`** plans stories from the design as it stands, before it is approved, and says they are drafts.

## Consequences

- The three-step path a team uses: `change new`, `change draft`, `plan stories --draft`; the critic and the approvals follow as before.
- Not yet: the map reads names, not meaning, so a brief that uses different words from the code finds less; the drafter writes no `data.md` or `design.md` checks beyond the file being allowed; stories from an interface aren't yet linked to the requirements they serve.
