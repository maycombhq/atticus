# Data

## Changes

| Data store | Table | Change | Migration |
| --- | --- | --- | --- |
| ledger-db | account | add column daily_limit numeric(18,2) not null default 1000 | V3__add_daily_limit.sql |

## Backfill, classification and retention

The default fills existing rows; no backfill job. The new column is internal.

## Other readers and writers

Only ledger-api reads or writes account.
