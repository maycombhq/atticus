# Data Model: Check the limit in the transfer transaction, with tests

**Data store**: ledger-db

## Entities

### account (existing table)

| Column | Type | Nullable | Notes |
| --- | --- | --- | --- |
| daily_limit | numeric(12,2) | no | the developer narrowed the type |

### limit_change (new table)

| Column | Type | Nullable | Notes |
| --- | --- | --- | --- |
| id | bigint |  |  |
| account_id | bigint |  |  |
| new_limit | numeric(18,2) |  |  |

### velocity_cache (new table)

| Column | Type | Nullable | Notes |
| --- | --- | --- | --- |
| account_id | bigint | no |  |
| checked_at | timestamp |  |  |
