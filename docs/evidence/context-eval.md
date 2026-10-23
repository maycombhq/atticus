<!-- Written by packages/evals/scripts/write-context-eval.mjs from runContextBench (ADR 0107 point 6). Don't edit: run the script again. -->
# The context engine's eval

Each step that sent a whole list, run on the Forge fixtures with the whole lists, with the context engine, and with the engine and its read-only tools, at the org pack's budget and at a tight one (the whole prompt less half the room the lists take). Recall: the share of the records a correct answer needs (from the golden answers) that the context names. Precision: the share of the records the context names that a correct answer needs. Tokens: the whole prompt, then the context in it; with tools, both count what the tools gave back.

With tools (ADR 0107 addendum) the model is a scripted mock, the same on every run, whose calls run through the real context tools against the case's index: it shows up to six ids the pack says it left out for room and searches the change's title, then shows up to five search hits the pack didn't have, then answers. Its recall is what a model that looks up what its pack lacks can reach; a real model may call fewer tools, or others. Its tokens are the first prompt and what the tools gave back; each round sends the conversation again, so a provider counts more.

| Step | Case | Budget | Context | Recall | Precision | Sent / needed | Tokens | Context tokens | Tool calls | Missing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| needs | shop: add-fraud-check | org pack | whole lists | 1.00 | 0.67 | 3 / 2 | 1370 | 434 | - | none |
| needs | shop: add-fraud-check | org pack | engine | 1.00 | 0.67 | 3 / 2 | 1400 | 464 | - | none |
| needs | shop: add-fraud-check | org pack | engine + tools | 1.00 | 0.20 | 10 / 2 | 2256 | 1320 | 5 | none |
| needs | shop: add-fraud-check | tight | whole lists | 0.00 | 0.00 | 1 / 2 | 1067 | 131 | - | firewall-rule-request, vendor-onboarding |
| needs | shop: add-fraud-check | tight | engine | 0.50 | 1.00 | 1 / 2 | 1092 | 100 | - | firewall-rule-request |
| needs | shop: add-fraud-check | tight | engine + tools | 1.00 | 0.20 | 10 / 2 | 2450 | 1458 | 7 | none |
| feature | shop: add-fraud-check | org pack | whole lists | 1.00 | 0.33 | 12 / 4 | 977 | 369 | - | none |
| feature | shop: add-fraud-check | org pack | engine | 1.00 | 0.33 | 12 / 4 | 977 | 369 | - | none |
| feature | shop: add-fraud-check | org pack | engine + tools | 1.00 | 0.33 | 12 / 4 | 1394 | 786 | 2 | none |
| feature | shop: add-fraud-check | tight | whole lists | 0.00 | 0.00 | 0 / 4 | 608 | 0 | - | cap-ordering, forge-orders.place-order, forge-stock.reserve-stock, northwind-pay |
| feature | shop: add-fraud-check | tight | engine | 1.00 | 0.33 | 12 / 4 | 776 | 168 | - | none |
| feature | shop: add-fraud-check | tight | engine + tools | 1.00 | 0.31 | 13 / 4 | 2555 | 1947 | 8 | none |
| feature | forge: add-transfer-limit | org pack | whole lists | 0.86 | 0.33 | 18 / 7 | 1741 | 328 | - | ledger-db.limit-change |
| feature | forge: add-transfer-limit | org pack | engine | 0.86 | 0.33 | 18 / 7 | 1741 | 328 | - | ledger-db.limit-change |
| feature | forge: add-transfer-limit | org pack | engine + tools | 0.86 | 0.29 | 21 / 7 | 2814 | 1401 | 4 | ledger-db.limit-change |
| feature | forge: add-transfer-limit | tight | whole lists | 0.00 | 0.00 | 0 / 7 | 1413 | 0 | - | audit, ledger, ledger-api.post-transfer, ledger-db.account, ledger-db.limit-change, northwind-pay, portal |
| feature | forge: add-transfer-limit | tight | engine | 0.86 | 0.33 | 18 / 7 | 1575 | 162 | - | ledger-db.limit-change |
| feature | forge: add-transfer-limit | tight | engine + tools | 0.86 | 0.27 | 22 / 7 | 3634 | 2221 | 10 | ledger-db.limit-change |
| architecture | shop: add-fraud-check | org pack | whole lists | 1.00 | 0.25 | 12 / 3 | 2308 | 370 | - | none |
| architecture | shop: add-fraud-check | org pack | engine | 1.00 | 0.25 | 12 / 3 | 2309 | 371 | - | none |
| architecture | shop: add-fraud-check | org pack | engine + tools | 1.00 | 0.25 | 12 / 3 | 3375 | 1437 | 6 | none |
| architecture | shop: add-fraud-check | tight | whole lists | 0.00 | 0.00 | 0 / 3 | 1938 | 0 | - | forge-orders-db.orders, forge-orders.place-order, northwind-pay |
| architecture | shop: add-fraud-check | tight | engine | 1.00 | 0.25 | 12 / 3 | 2091 | 153 | - | none |
| architecture | shop: add-fraud-check | tight | engine + tools | 1.00 | 0.23 | 13 / 3 | 3927 | 1989 | 12 | none |
| stories | shop: add-fraud-check | org pack | whole lists | 1.00 | 0.67 | 3 / 2 | 1126 | 149 | - | none |
| stories | shop: add-fraud-check | org pack | engine | 1.00 | 1.00 | 2 / 2 | 1089 | 112 | - | none |
| stories | shop: add-fraud-check | org pack | engine + tools | 1.00 | 1.00 | 2 / 2 | 1089 | 112 | 0 | none |
| stories | shop: add-fraud-check | tight | whole lists | 1.00 | 0.67 | 3 / 2 | 1010 | 149 | - | none |
| stories | shop: add-fraud-check | tight | engine | 1.00 | 1.00 | 2 / 2 | 1048 | 71 | - | none |
| stories | shop: add-fraud-check | tight | engine + tools | 1.00 | 1.00 | 2 / 2 | 1563 | 586 | 2 | none |

A step uses the engine by default only where its recall is at least the whole lists' on every case and budget:

- needs: the engine
- feature: the engine
- architecture: the engine
- stories: the engine

With tools, a step's pack may start smaller only where the engine with tools at the tight budget recalls at least what the engine alone does at the org pack's, on every case:

- needs: recall holds with the tight pack and tools; 2450 tokens in all with tools against 1400 for the engine's full pack, so the pack stays as it is
- feature: recall holds with the tight pack and tools; 6189 tokens in all with tools against 2718 for the engine's full pack, so the pack stays as it is
- architecture: recall holds with the tight pack and tools; 3927 tokens in all with tools against 2309 for the engine's full pack, so the pack stays as it is
- stories: recall holds with the tight pack and tools; 1563 tokens in all with tools against 1089 for the engine's full pack, so the pack stays as it is
