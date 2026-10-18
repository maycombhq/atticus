---
id: forge-migrations
name: Write a Forge database migration
description: How to add a Flyway migration to a Forge service, with its rollback note and a test.
appliesTo:
  repoTypes: [forge-service]
  artifacts: [data, tasks]
owner: team-ledger
source: inputs/wiki/ledger-solution-spec.md
status: active
reviewedAt: 2026-10-01
---

1. Add `src/main/resources/db/migration/V<n>__<what>.sql` with the next free number.
2. Never edit a migration that has been released; add a new one.
3. Give every new column a default or a backfill, and say in data.md how to roll back.
4. Run the service's migration test against an empty database and against the last release.
