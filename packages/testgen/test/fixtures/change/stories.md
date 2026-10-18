# Stories

| Story | Title | Repos | Depends on |
| --- | --- | --- | --- |
| s1-daily-transfer-limit | Refuse transfers over the daily limit | forge-ledger, forge-portal-bff, forge-portal-ui |  |
| s2-remaining-limit | Show the remaining limit | forge-ledger, forge-portal-bff, forge-portal-ui | s1-daily-transfer-limit |
| s3-northwind-pay-velocity-checks | Check unusual transfers with Northwind Pay | forge-ledger |  |
| s4-limit-change-events | Record and publish limit changes | forge-ledger, forge-reports-job |  |
