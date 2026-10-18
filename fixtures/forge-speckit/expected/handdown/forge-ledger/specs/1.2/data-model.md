# Data Model: Check the limit in the transfer transaction, with tests

**Data store**: ledger-db

<!-- Seeded by Atticus from data.md of change add-transfer-limit. Keep the headings and tables in this shape: Atticus reads them on every scan. -->

## Entities

### account (existing table)

| Column | Type | Nullable | Notes |
| --- | --- | --- | --- |
| daily_limit | numeric(18,2) | no | add column daily_limit numeric(18,2) not null default 1000 (V3__add_daily_limit.sql) |

### limit_change (new table)

| Column | Type | Nullable | Notes |
| --- | --- | --- | --- |
| id | bigint |  |  |
| account_id | bigint |  |  |
| old_limit | numeric(18,2) |  |  |
| new_limit | numeric(18,2) |  |  |
| changed_by_email | varchar(200) |  |  |
| changed_at | timestamp |  |  |
