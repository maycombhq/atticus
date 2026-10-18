# Forge change: the M3 exit fixture

An invented Forge feature change, `add-transfer-limit`, with every org-flow artifact written by hand and problems seeded on purpose. It runs on top of `fixtures/forge` (org pack and expected catalog), which it never changes.

| Folder | What it holds |
| --- | --- |
| `openspec/changes/add-transfer-limit/` | The change folder at the plan phase: `change.yaml`, brief, proposal, specs, interfaces, mappings, data, design, UX, stories, tasks and service-desk drafts |
| `org-pack/` | New org-pack files laid over the Forge pack: critic agents for six lenses and the Ledger team's checklist (`teams/team-ledger/checklists/`) |
| `recordings/` | Replay recordings for the AI lenses, written by hand as the mock runtime would return them, keyed by agent and prompt hash |
| `expected/findings.yaml` | The seeded problems (14 blocking issues, 13 knowledge gaps) and the other findings the critic must raise, with the layer that must catch each |

The change adds a daily limit to ledger-api's POST /transfers, touches portal-bff, ledger-api, audit-svc and ledger-db, and adds a call to Northwind Pay. Seeded problems include a pattern-code typo, a hop with no pattern, a call to a system the catalog doesn't know, vendor and internal calls with no timeouts, a new table with no migration, retention or personal-data classification, a story without acceptance criteria, a story that addresses AI reviewers, missing and incomplete service-desk drafts, and gaps such as the unknown audit-svc owner and the vendor's unknown rate limit.

Rules: the expected file and the recordings are hand-written; never regenerate them from critic output. A changed prompt makes the replay fail with the new prompt hash; update the recording's hash only after checking the hand-written answer still fits the prompt.
