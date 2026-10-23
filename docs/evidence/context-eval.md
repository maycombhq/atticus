<!-- Written by packages/evals/scripts/write-context-eval.mjs from runContextBench (ADR 0107 point 6). Don't edit: run the script again. -->
# The context engine's eval

Each step that sent a whole list, run on the Forge fixtures with the whole lists and with the context engine, at the org pack's budget and at a tight one (the whole prompt less half the room the lists take). Recall: the share of the records a correct answer needs (from the golden answers) that the context names. Precision: the share of the records the context names that a correct answer needs. Tokens: the whole prompt, then the context in it.

| Step | Case | Budget | Context | Recall | Precision | Sent / needed | Tokens | Context tokens | Missing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| needs | shop: add-fraud-check | org pack | whole lists | 1.00 | 0.67 | 3 / 2 | 1332 | 434 | none |
| needs | shop: add-fraud-check | org pack | engine | 1.00 | 0.67 | 3 / 2 | 1362 | 464 | none |
| needs | shop: add-fraud-check | tight | whole lists | 0.00 | 0.00 | 1 / 2 | 1029 | 131 | firewall-rule-request, vendor-onboarding |
| needs | shop: add-fraud-check | tight | engine | 0.50 | 1.00 | 1 / 2 | 998 | 100 | firewall-rule-request |
| feature | shop: add-fraud-check | org pack | whole lists | 1.00 | 0.33 | 12 / 4 | 974 | 366 | none |
| feature | shop: add-fraud-check | org pack | engine | 1.00 | 0.33 | 12 / 4 | 974 | 366 | none |
| feature | shop: add-fraud-check | tight | whole lists | 0.00 | 0.00 | 0 / 4 | 608 | 0 | cap-ordering, forge-orders.place-order, forge-stock.reserve-stock, northwind-pay |
| feature | shop: add-fraud-check | tight | engine | 1.00 | 0.33 | 12 / 4 | 776 | 168 | none |
| feature | forge: add-transfer-limit | org pack | whole lists | 0.86 | 0.33 | 18 / 7 | 1741 | 328 | ledger-db.limit-change |
| feature | forge: add-transfer-limit | org pack | engine | 0.86 | 0.33 | 18 / 7 | 1741 | 328 | ledger-db.limit-change |
| feature | forge: add-transfer-limit | tight | whole lists | 0.00 | 0.00 | 0 / 7 | 1413 | 0 | audit, ledger, ledger-api.post-transfer, ledger-db.account, ledger-db.limit-change, northwind-pay, portal |
| feature | forge: add-transfer-limit | tight | engine | 0.86 | 0.33 | 18 / 7 | 1575 | 162 | ledger-db.limit-change |
| architecture | shop: add-fraud-check | org pack | whole lists | 1.00 | 0.25 | 12 / 3 | 2254 | 367 | none |
| architecture | shop: add-fraud-check | org pack | engine | 1.00 | 0.25 | 12 / 3 | 2255 | 368 | none |
| architecture | shop: add-fraud-check | tight | whole lists | 0.00 | 0.00 | 0 / 3 | 1887 | 0 | forge-orders-db.orders, forge-orders.place-order, northwind-pay |
| architecture | shop: add-fraud-check | tight | engine | 1.00 | 0.25 | 12 / 3 | 2040 | 153 | none |
| stories | shop: add-fraud-check | org pack | whole lists | 1.00 | 0.67 | 3 / 2 | 1126 | 149 | none |
| stories | shop: add-fraud-check | org pack | engine | 1.00 | 1.00 | 2 / 2 | 1089 | 112 | none |
| stories | shop: add-fraud-check | tight | whole lists | 1.00 | 0.67 | 3 / 2 | 1010 | 149 | none |
| stories | shop: add-fraud-check | tight | engine | 1.00 | 1.00 | 2 / 2 | 1048 | 71 | none |

A step uses the engine by default only where its recall is at least the whole lists' on every case and budget:

- needs: the engine
- feature: the engine
- architecture: the engine
- stories: the engine
