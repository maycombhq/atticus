<!-- Written by packages/evals/scripts/write-context-eval.mjs from runContextBench (ADR 0107 point 6). Don't edit: run the script again. -->
# The context engine's eval

Each step that sent a whole list, run on the Forge fixtures with the whole lists, with the context engine, and with the engine and its read-only tools, at the org pack's budget and at a tight one (the whole prompt less half the room the lists take). Recall: the share of the records a correct answer needs (from the golden answers) that the context names. Precision: the share of the records the context names that a correct answer needs. Tokens: the whole prompt, then the context in it; with tools, both count what the tools gave back.

With tools (ADR 0107 addendum) the model is a scripted mock, the same on every run, whose calls run through the real context tools against the case's index: it shows up to six ids the pack says it left out for room and searches the change's title, then shows up to five search hits the pack didn't have, then answers. Its recall is what a model that looks up what its pack lacks can reach; a real model may call fewer tools, or others. Its tokens are the first prompt and what the tools gave back; each round sends the conversation again, so a provider counts more.

| Step | Case | Budget | Context | Recall | Precision | Sent / needed | Tokens | Context tokens | Tool calls | Missing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| needs | shop: add-fraud-check | org pack | whole lists | 1.00 | 0.67 | 3 / 2 | 1370 | 434 | - | none |
| needs | shop: add-fraud-check | org pack | engine | 1.00 | 0.67 | 3 / 2 | 1400 | 464 | - | none |
| needs | shop: add-fraud-check | org pack | engine + tools | 1.00 | 0.18 | 11 / 2 | 2341 | 1405 | 6 | none |
| needs | shop: add-fraud-check | tight | whole lists | 0.00 | 0.00 | 1 / 2 | 1067 | 131 | - | firewall-rule-request, vendor-onboarding |
| needs | shop: add-fraud-check | tight | engine | 0.50 | 1.00 | 1 / 2 | 1092 | 100 | - | firewall-rule-request |
| needs | shop: add-fraud-check | tight | engine + tools | 1.00 | 0.18 | 11 / 2 | 2535 | 1543 | 8 | none |
| feature | shop: add-fraud-check | org pack | whole lists | 1.00 | 0.33 | 12 / 4 | 977 | 369 | - | none |
| feature | shop: add-fraud-check | org pack | engine | 1.00 | 0.33 | 12 / 4 | 977 | 369 | - | none |
| feature | shop: add-fraud-check | org pack | engine + tools | 1.00 | 0.29 | 14 / 4 | 1479 | 871 | 3 | none |
| feature | shop: add-fraud-check | tight | whole lists | 0.00 | 0.00 | 0 / 4 | 608 | 0 | - | cap-ordering, forge-orders.place-order, forge-stock.reserve-stock, northwind-pay |
| feature | shop: add-fraud-check | tight | engine | 1.00 | 0.33 | 12 / 4 | 776 | 168 | - | none |
| feature | shop: add-fraud-check | tight | engine + tools | 1.00 | 0.27 | 15 / 4 | 2638 | 2030 | 9 | none |
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

- needs: recall holds with the tight pack and tools; 2535 tokens in all with tools against 1400 for the engine's full pack, so the pack stays as it is
- feature: recall holds with the tight pack and tools; 6272 tokens in all with tools against 2718 for the engine's full pack, so the pack stays as it is
- architecture: recall holds with the tight pack and tools; 3927 tokens in all with tools against 2309 for the engine's full pack, so the pack stays as it is
- stories: recall holds with the tight pack and tools; 1563 tokens in all with tools against 1089 for the engine's full pack, so the pack stays as it is

## Retrieval cases (ADR 0116)

61 inputs from `fixtures/retrieval/cases.yaml`, run straight through `selectContext` on two roots: the Forge scan with 208 look-alike records of eight other systems, three glossary terms and their curated aliases, a long wiki page and a Word runbook in `inputs/`; and the shop with its wiki and knowledge items. Budgets: 3000 tokens (normal) and 600 (tight). Each cell is recall / precision / MRR, averaged over the group's cases; for inputs nothing answers it is how many records were picked anyway.

Before ADR 0116 (the engine of ADR 0107 point 3: BM25 sums, whole wiki sections, no documents; measured at commit 464b758), all answered cases scored 0.72 / 0.03 / 0.28 at the normal budget and 0.49 / 0.06 / 0.27 at the tight one.

| Group | Cases | words normal | words tight | +split normal | +split tight | lexical normal | lexical tight |
| --- | --- | --- | --- | --- | --- | --- | --- |
| identifier | 4 | 1.00 / 0.02 / 0.11 | 0.50 / 0.04 / 0.08 | 1.00 / 0.03 / 0.75 | 1.00 / 0.10 / 0.75 | 1.00 / 0.03 / 0.75 | 1.00 / 0.11 / 0.75 |
| paraphrase | 23 | 0.65 / 0.04 / 0.16 | 0.26 / 0.04 / 0.14 | 0.65 / 0.04 / 0.20 | 0.30 / 0.05 / 0.19 | 0.65 / 0.04 / 0.20 | 0.30 / 0.05 / 0.19 |
| synonym | 3 | 1.00 / 0.04 / 0.31 | 1.00 / 0.10 / 0.31 | 1.00 / 0.03 / 0.24 | 1.00 / 0.10 / 0.24 | 1.00 / 0.03 / 0.73 | 1.00 / 0.11 / 0.73 |
| multi-hop | 4 | 1.00 / 0.06 / 0.27 | 0.63 / 0.10 / 0.25 | 1.00 / 0.06 / 0.27 | 0.63 / 0.10 / 0.25 | 1.00 / 0.06 / 0.27 | 0.63 / 0.10 / 0.25 |
| distractor | 5 | 1.00 / 0.02 / 0.29 | 0.80 / 0.08 / 0.28 | 1.00 / 0.02 / 0.37 | 0.80 / 0.08 / 0.37 | 1.00 / 0.02 / 0.37 | 0.80 / 0.08 / 0.37 |
| document | 4 | 0.75 / 0.02 / 0.37 | 0.25 / 0.03 / 0.25 | 0.75 / 0.01 / 0.27 | 0.25 / 0.02 / 0.13 | 0.75 / 0.01 / 0.27 | 0.25 / 0.02 / 0.13 |
| long-wiki | 5 | 0.80 / 0.02 / 0.37 | 0.20 / 0.03 / 0.20 | 0.60 / 0.01 / 0.30 | 0.20 / 0.03 / 0.20 | 0.60 / 0.01 / 0.30 | 0.20 / 0.03 / 0.20 |
| exact | 9 | 1.00 / 0.05 / 1.00 | 1.00 / 0.12 / 1.00 | 1.00 / 0.05 / 1.00 | 1.00 / 0.12 / 1.00 | 1.00 / 0.05 / 1.00 | 1.00 / 0.13 / 1.00 |
| no-answer | 4 | 0.0 picked | 0.0 picked | 0.0 picked | 0.0 picked | 0.0 picked | 0.0 picked |
| all | 57 | 0.82 / 0.04 / 0.35 | 0.50 / 0.06 / 0.32 | 0.81 / 0.04 / 0.40 | 0.55 / 0.07 / 0.38 | 0.81 / 0.04 / 0.43 | 0.55 / 0.07 / 0.40 |

Not built yet: +expansion, +rerank, +embeddings.

A mode becomes a step's default only where its recall is at least the lexical engine's on every case and budget:

- only the lexical engine is built

### Per case (normal budget): the rank of the first needed pick, 0 when it isn't picked

| Case | Group | words | +split | lexical | Missing (lexical) |
| --- | --- | --- | --- | --- | --- |
| forge-show-renamed-time | identifier | 27 | 2 | 2 | none |
| forge-renamed-timestamp | identifier | 16 | 1 | 1 | none |
| forge-closed-at | identifier | 11 | 1 | 1 | none |
| forge-daily-limit-amount | identifier | 4 | 2 | 2 | none |
| forge-spending-cap | paraphrase | 7 | 5 | 5 | none |
| forge-card-issuer | paraphrase | 0 | 0 | 0 | northwind-pay |
| forge-most-per-day | paraphrase | 20 | 23 | 23 | none |
| forge-move-money | paraphrase | 40 | 45 | 45 | none |
| forge-money-left | paraphrase | 20 | 25 | 25 | none |
| forge-owner-name | paraphrase | 1 | 1 | 1 | none |
| forge-booking-hit | paraphrase | 40 | 51 | 51 | none |
| forge-page-someone | paraphrase | 24 | 25 | 25 | none |
| forge-wait-answer | paraphrase | 6 | 6 | 6 | none |
| forge-schema-changes | paraphrase | 0 | 0 | 0 | ledger-db.v1, ledger-db.v2 |
| forge-permissions | paraphrase | 0 | 0 | 0 | gw-ledger-v1.oauth-scopes |
| forge-who-did-what | paraphrase | 0 | 0 | 0 | audit |
| forge-overnight-batch | paraphrase | 11 | 1 | 1 | none |
| forge-friendly-label | paraphrase | 13 | 14 | 14 | none |
| forge-withdrawal-ceiling | synonym | 4 | 4 | 1 | none |
| forge-beneficial-owner | synonym | 2 | 3 | 1 | none |
| forge-booking-date | synonym | 6 | 7 | 5 | none |
| forge-who-calls-nwp | multi-hop | 3 | 3 | 3 | none |
| forge-reports-feed | multi-hop | 6 | 6 | 6 | none |
| forge-balance-route | multi-hop | 15 | 12 | 12 | none |
| forge-ledger-migrations | multi-hop | 2 | 2 | 2 | none |
| forge-account-shut | distractor | 31 | 33 | 33 | none |
| forge-ledger-connect | distractor | 3 | 3 | 3 | none |
| forge-portal-balance | distractor | 2 | 2 | 2 | none |
| forge-account-number | distractor | 4 | 2 | 2 | none |
| forge-ledger-nickname | distractor | 3 | 2 | 2 | none |
| forge-late-transfer | document | 0 | 0 | 0 | settled on the next business day |
| forge-charged-twice | document | 3 | 3 | 3 | none |
| forge-weekend-settlement | document | 1 | 2 | 2 | none |
| forge-frozen-account | document | 7 | 4 | 4 | none |
| forge-unmatched-entries | long-wiki | 5 | 6 | 6 | none |
| forge-vendor-retry | long-wiki | 0 | 0 | 0 | retried three times |
| forge-vendor-maintenance | long-wiki | 3 | 0 | 0 | first Sunday of each month |
| forge-back-dated | long-wiki | 1 | 1 | 1 | none |
| forge-off-by-a-cent | long-wiki | 3 | 3 | 3 | none |
| forge-post-transfers | exact | 1 | 1 | 1 | none |
| forge-get-balance-id | exact | 1 | 1 | 1 | none |
| forge-nwp-name | exact | 1 | 1 | 1 | none |
| forge-ledger-platform | exact | 1 | 1 | 1 | none |
| forge-topic-name | exact | 1 | 1 | 1 | none |
| forge-entry-table | exact | 1 | 1 | 1 | none |
| forge-none-button | no-answer | 0 picked | 0 picked | 0 picked | none |
| forge-none-mortgage | no-answer | 0 picked | 0 picked | 0 picked | none |
| forge-none-canteen | no-answer | 0 picked | 0 picked | 0 picked | none |
| shop-open-port | paraphrase | 2 | 2 | 2 | none |
| shop-new-supplier | paraphrase | 18 | 18 | 18 | none |
| shop-queue-subject | paraphrase | 1 | 1 | 1 | none |
| shop-hold-inventory | paraphrase | 0 | 0 | 0 | forge-stock.post-stock-reservations |
| shop-shopper-buys | paraphrase | 0 | 0 | 0 | forge-orders.place-order |
| shop-cancel-purchase | paraphrase | 0 | 0 | 0 | forge-orders.delete-orders-orderid |
| shop-how-many | paraphrase | 0 | 0 | 0 | forge-orders-db.orders.quantity |
| shop-when-made | paraphrase | 21 | 19 | 19 | none |
| shop-full-card-number | paraphrase | 2 | 2 | 2 | none |
| shop-fraud-score | exact | 1 | 1 | 1 | none |
| shop-nwp-alias | exact | 1 | 1 | 1 | none |
| shop-stock-reservation | exact | 1 | 1 | 1 | none |
| shop-none-parking | no-answer | 0 picked | 0 picked | 0 picked | none |
