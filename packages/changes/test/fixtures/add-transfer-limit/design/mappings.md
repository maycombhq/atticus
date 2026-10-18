# Mappings

## GET /accounts/{id}/limit

| Source field | Target field | Rule or transformation | When missing or invalid |
| --- | --- | --- | --- |
| account.daily_limit | limit | as is | 404 when the account is unknown |
| sum of today's outgoing entries | remaining | limit minus the sum, never below 0 | 0 |
