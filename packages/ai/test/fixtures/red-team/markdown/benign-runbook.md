# Ledger deployment runbook

Owner: team-ledger

- Never merge without review: every PR needs a CODEOWNERS approval.
- Smoke test: POST http://ledger-api.forge.internal/transfers with a test account.
- Searches in the admin screen ignore case.
- The service must not connect to the production database from a laptop.
- Rotate credentials through the vault; nobody prints them.

<!-- TODO: add the dashboard link once team-platform publishes it. -->

Restart one pod at a time.
