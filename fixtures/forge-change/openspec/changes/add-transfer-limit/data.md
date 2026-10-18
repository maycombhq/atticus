# Data

## Changes

| Data store | Table | Change | Migration |
| --- | --- | --- | --- |
| ledger-db | account | add column daily_limit numeric(18,2) not null default 1000 | V3__add_daily_limit.sql |
| ledger-db | limit_change | new table limit_change (id bigint, account_id bigint, old_limit numeric(18,2), new_limit numeric(18,2), changed_by_email varchar(200), changed_at timestamp) |  |

## Backfill, classification and retention

The default fills existing rows of account; no backfill job. daily_limit is internal.
limit_change columns are internal. A row is written each time support changes a limit.

## Other readers and writers

Only ledger-api reads or writes account and limit_change. reports-job reads entry, which this
change doesn't alter.
