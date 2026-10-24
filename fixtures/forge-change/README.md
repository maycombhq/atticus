# Forge change: the M3 exit fixture

An invented Forge feature change, `add-transfer-limit`, with every org-flow artifact written by hand and problems seeded on purpose. It runs on top of `fixtures/forge` (org pack and expected catalog), which it never changes.

| Folder | What it holds |
| --- | --- |
| `openspec/changes/add-transfer-limit/` | The change folder at the plan phase: `change.yaml`, brief, proposal, specs, interfaces, mappings, data, design, UX, stories, tasks and service-desk drafts |
| `org-pack/` | New org-pack files laid over the Forge pack: the critic's four question agents (`true-critic`, `complete-critic`, `safe-critic`, `ship-critic`), `code-and-test-critic` for the spec hand-up's review of a task, and the Ledger team's checklist (`teams/team-ledger/checklists/`) |
| `recordings/` | Replay recordings for the AI lenses, written by hand as the mock runtime would return them, keyed by agent and prompt hash |
| `expected/stories.yaml` | The outline the planner's stories must meet for the story bar (stories, gaps they cover, nothing invented); hand-written |
| `recordings/story-writer/` | Replay recordings for the story writer's prose, written by hand |
| `expected/findings.yaml` | The seeded problems (12 blocking issues, 14 knowledge gaps), the other findings the critic must raise with the layer that must catch each, and the findings retired with the four questions |

The change adds a daily limit to ledger-api's POST /transfers, touches portal-bff, ledger-api, audit-svc and ledger-db, and adds a call to Northwind Pay. Seeded problems include a pattern-code typo, a hop with no pattern, a call to a system the catalog doesn't know, vendor and internal calls with no timeouts, a new table with no migration, retention or personal-data classification, a story without acceptance criteria, a story that addresses AI reviewers, and gaps such as the unknown audit-svc owner and the vendor's unknown rate limit.

Rules: the expected file and the recordings are hand-written; never regenerate them from critic output. A changed prompt makes the replay fail with the new prompt hash; update the recording's hash only after checking the hand-written answer still fits the prompt.

## Re-baselined for the four questions (ADR 0124 addendum, Part 4)

The critic asks four questions of every draft (is it true to the code, is it complete, is it safe to build, can it ship) with one AI lens per question, instead of seven role lenses. The fixture was re-baselined for it on 2026-10-24.

**Retired** (listed under `retired:` in `expected/findings.yaml`; the golden tests check none comes back):

| Was | Rule | Why it retired |
| --- | --- | --- |
| b11 (no firewall draft), b12 (gateway draft missing its Target) | `constitution.snow-drafts-present` | A service-desk request is a person's manual step now: `atticus plan` drafts snow.md from the same triggers, and `atticus release plan` lists each draft as a request to file, with its missing required fields. The constitution rule is retired; the check stays for an org pack that wants it. |
| r04 (no error state when the limit can't load) | `ux-states-complete` | The UX lens is gone. The Ledger team's rule is kept in its checklist with `status: retired`; a screen state the specs imply is one of the things the complete lens looks for. |

**Kept**: every other seeded blocking issue, caught by the same layer as before (b01 to b10 by code, b13 and b14 by the safe and complete lenses), every seeded gap, and the knowledge needs (slo-known, capacity-known, vendor-rate-limit-known, vendor-contact-known, vendor-operation-known).

**Added**: g14 (nothing records how audit-svc authenticates callers of POST /audit/events, `constitution.public-entry-auth`), r06 (the audit call states no timeout, `constitution.call-timeout-stated`), r07 and r08 (design.md's rollback names neither table, `constitution.store-write-rollback`), and r09 (snow.md now passes layer 1 and reaches the ship lens, which finds no fallback if the gateway proxy request is late, `release-plan-complete`).

**The Ledger team's rules** are written for the questions (`lens: safe`, `lens: complete`, …). `tests-cover-scenarios` keeps `lens: code-and-test` with `question: complete`, because the spec hand-up reviews a task's code and tests with the code-and-test lens's agent. The Forge pack under `fixtures/forge` is unchanged and still uses the old lens names, so the fixture also tests that an org pack written for the seven lenses keeps working (its `design-has-rollback`, written for the delivery lens, is the ship lens's).

**The recordings were re-made deterministically, with no model.** A new lens prompt has a new sha256, so each question agent's answer was written by hand: complete-critic's is the old business and story lenses' answers together, safe-critic's the old architecture lens's, ship-critic's the old delivery lens's plus r09. Each answer is stored under the hash of every exact prompt its lens sends in the tests (the plain run, the runs that carry `recorded-by-people`, and the M3 exit sandbox), by running those tests once with a replay runtime that wrote the hand-written answer under the prompt hash it was given. The answers were checked against what each lens must find (the `layer: ai` entries of `expected/findings.yaml` whose rules the lens applies); `packages/naysayer/test/golden.test.ts` and `packages/evals` replay them.
