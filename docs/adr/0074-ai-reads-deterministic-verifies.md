# 0074. The AI reads the code; a thin deterministic layer verifies

- Status: accepted (decided by the product owner; ADR text pending review)
- Date: 2026-10-21
- Supersedes: CLAUDE.md rule 4 as it stood ("Deterministic scans ... no AI calls inside a scan"), and the parts of ADR 0059 and 0072 that keep the AI out of the scan itself.

## Context

On the first real repo scanned end to end, almost every built-in reader needed a fix: modules weren't recognised, JPQL named entities instead of tables, upserts produced a table called `set`, the app's own HTTP helpers weren't followed, every module took the repo's type, SQL comparisons and CTE names were read as tables. Each fix was generic, each was found only by contact with real code, and each was made by an Atticus developer. At another organisation no one will be there to find and fix them, and an organisation can't wait for a release. Hand-written readers can't keep up with every organisation's code; a misread doesn't even show as a gap.

## Decision

Discovery moves to the AI. A scan runs **AI → deterministic → AI**:

1. **AI first.** Survey the repo, match it against the known repo-type profiles (by fingerprint, confirmed by the agent), and decide whether the scanner needs customising to read everything a repo of that type holds.
2. **The AI customises the scanner, as a change.** The lightest thing that works: a rule file (rules, dialects, framework models, overrides of built-in readers) when the rule format can express it; a scanner plugin in code when it can't, developed as a change in the metarepo (spec, golden-file tests, the critic, a merged PR), loaded only then, run sandboxed (read-only files, no network, limits), versioned and pinned.
3. **Deterministic.** The scanner runs with that configuration.
4. **AI last.** Verify the result against the AI's own reading of the code; every fact's citation (file and line) is confirmed by a deterministic check; what fails goes back to step 2.
5. **Ambiguity stops the loop as a question to a person.** The answer is written to a file in the metarepo; an answer about one repo is a recorded decision, an answer about a repo type or framework goes into the agent's skill for that type. The rerun reads them; an answered question is never asked again.

What stays deterministic, because a bank needs it: the citation check (no fact without its file and line; the check confirms what it can, such as a named endpoint, table or field at that line, and the record shows whether the check, the AI or a person confirmed the rest), reproducibility (verified results stored per commit; the same commit, org pack and answers return the same stored catalog, not a fresh AI run; a changed file invalidates only the facts and flows that cite it), and the checks on outputs (the critic's rules, the draft checks). A document still never overrides a fact verified from code. The built-in readers become an optional fast path and a cross-check: agreement confirms, disagreement is a finding.

Every onboarded repo gets a spec of what it is today (entry points and exits, logic, field-level mappings, data reads and writes, configuration and deployment, with evidence), and an estate pass connects the repos end to end. Changes are drafted against these specs, through feature, architecture and stories stages that each iterate with the critic until nothing is flagged and a person approves the stage's PR.

## Consequences

- Atticus adapts to an organisation's code at the organisation, from its own answers and reviewed rules and plugins, without an Atticus release; the profiles, skills and decisions are that organisation's learned scanner.
- A scan needs a model the organisation approves, and model time on an estate's first scan; for now quality comes before cost and calls are not capped.
- Built first: a bench of public open-source repos across stacks, scored on found, missed and wrong, so the change is measured; then a prototype on one real repo, compared with the current catalog.
- Tests still never call a model: the AI runtime's mock and replay runtimes stand in (CLAUDE.md rule 5).
- The to-do list in `docs/build-status.md` (group I, B10, F3) carries the work.
