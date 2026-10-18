# Mappings

## POST /transfers

No mapping change. The response gains error LIMIT_EXCEEDED (HTTP 422) with the remaining limit.

## GET /accounts/{id}/limit

| Source field | Target field | Rule or transformation | When missing or invalid |
| --- | --- | --- | --- |
| account.daily_limit | limit | as is | 404 when the account is unknown |
| sum of today's outgoing entries | remaining | limit minus the sum, never below 0 | 0 |

## POST /v2/velocity-checks

| Source field | Target field | Rule or transformation | When missing or invalid |
| --- | --- | --- | --- |
| account.account_number | accountRef | hashed with the shared key | refuse the transfer |
| transfer amount | amount.value | as is, two decimals | refuse the transfer |

## POST /audit/events

| Source field | Target field | Rule or transformation | When missing or invalid |
| --- | --- | --- | --- |
| account id | subject | as is | not sent |
| "limit-refused" | eventType | constant | not sent |
