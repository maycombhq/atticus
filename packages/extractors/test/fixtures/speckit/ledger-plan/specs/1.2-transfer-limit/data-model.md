# Data Model: Check the limit in the transfer transaction

**Data store**: ledger-db

## Entities

### account (existing table)

| Column | Type | Nullable | Notes |
| --- | --- | --- | --- |
| id | bigint | no | existing |
| daily_limit | numeric(18,2) | no | new column, default 1000 |

### limit_change (new table)

| Column | Type | Nullable | Notes |
| --- | --- | --- | --- |
| id | bigint | no | primary key |
| account_id | bigint | no | references account |
| new_limit | numeric(18,2) | no | |

### velocity_cache (new table)

- **account_id**: bigint, not null
- **checked_at**: timestamp
- **answer**: varchar(20)

## Notes

Free prose here is never read by the scan.
