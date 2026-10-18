# Tasks

## forge-ledger

- [ ] 1.1 Change POST /transfers; add column account.daily_limit with a migration, with tests (story s1-daily-transfer-limit)
- [ ] 1.2 Add GET /accounts/{id}/limit, with tests (story s2-remaining-limit)
- [ ] 1.3 Call POST /v2/velocity-checks on northwind-pay, with tests (story s3-northwind-pay-velocity-checks)
- [ ] 1.4 Create table limit_change and publish limits.changed, with tests (story s4-limit-change-events)

## forge-portal-bff

- [ ] 2.1 Update the call to POST /transfers on ledger-api, with tests (story s1-daily-transfer-limit)
- [ ] 2.2 Call GET /accounts/{id}/limit on ledger-api, with tests (story s2-remaining-limit)

## forge-reports-job

- [ ] 3.1 Subscribe to limits.changed, with tests (story s4-limit-change-events)
