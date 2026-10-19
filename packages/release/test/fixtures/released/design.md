# Design

## Approach

ledger-api sums today's outgoing entries for the account inside the transfer transaction and
refuses the transfer when the new total would pass account.daily_limit. portal-bff reads the
remaining limit from GET /accounts/{id}/limit.

## Rollout and rollback

Migration first, then ledger-api, then portal-bff and portal-ui.
To roll back ledger-api, redeploy the previous ledger-api image; the new column stays.
V3__add_daily_limit.sql is expand-only, so rolling back needs no down migration.
Roll back the other repos by redeploying their previous release.

## Readiness

The runbook for limit refusals is published and on-call for team-ledger has read it.

## Verification

After each step, send one transfer under and one over a test account's limit in prod.

## Hypercare

team-ledger watches the Ledger API error-rate alert for five working days after release.
