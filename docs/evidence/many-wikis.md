<!-- Written from packages/evals/src/many-wikis-bench.ts (runManyWikisBench, renderManyWikisTable) on 2026-10-26: the planted pages, and the generator's filler at scale 1. -->

# Many wikis: the matching, measured (ADR 0132)

The invented Forge shop's 12 sources and a change of 14 tasks, the expected pages written by hand before the code (fixtures/many-wikis/expected.yaml). Before: no source's authority, scope or page status. After: all of them. Recall: the share of the items a task needs that it lists. Precision: the share of what it lists, less what is allowed either way, that it needs. Never: listed though it must not be (out of scope, restricted, a mirror). Leads: topics led by the expected page. Suggested: disagreements whose suggested page and signal are the expected ones.

| Run | Selection | Recall | Precision | Never | Leads | Suggested | Order |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 12 sources, planted pages (32 pages) | before | 0.96 | 0.39 | 2 | 2 / 7 | 0 / 4 | 0 / 0 |
| 12 sources, planted pages (32 pages) | after | 0.96 | 0.50 | 0 | 5 / 5 | 3 / 4 | 1 / 1 |
| 12 sources, filler at scale 1 (4832 pages) | before | 0.96 | 0.27 | 2 | 2 / 7 | 0 / 4 | 0 / 0 |
| 12 sources, filler at scale 1 (4832 pages) | after | 0.96 | 0.34 | 0 | 5 / 5 | 3 / 4 | 0 / 0 |

Per task:

| Run | Task | Selection | Recall | Precision | Missing | Not needed | Never | Wrong lead or suggestion |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 12 sources, planted pages | 1.1 | after | 1.00 | 0.60 | none | 2: idempotency-keys, caller-customer-check | none | none |
| 12 sources, planted pages | 1.1 | before | 1.00 | 0.50 | none | 3: idempotency-keys, caller-customer-check, angular-form-validation | none | none |
| 12 sources, planted pages | 1.2 | after | 1.00 | 0.33 | none | 2: api-resource-naming, orders-team/api/api-errors.md#The error body | none | none |
| 12 sources, planted pages | 1.2 | before | 1.00 | 0.20 | none | 4: api-resource-naming, orders-team/api/api-errors.md#The error body, order-page-layout, payments-api-conventions | none | none |
| 12 sources, planted pages | 1.3 | after | 1.00 | 0.67 | none | 1: api-resource-naming | none | none |
| 12 sources, planted pages | 1.3 | before | 1.00 | 0.67 | none | 1: api-resource-naming | none | order-events-v2 led by orders-team/events/order-events-v1.md; orders-team/events/order-events-v1.md leads |
| 12 sources, planted pages | 1.4 | after | 0.50 | 0.33 | internal-tls | 2: replay-failed-refund, ea-standards/Meeting-notes/2026-09-12-Architecture-Review-Board.md#Discussed | none | internal-tls: not listed |
| 12 sources, planted pages | 1.4 | before | 0.50 | 0.33 | internal-tls | 2: replay-failed-refund, ea-standards/Meeting-notes/2026-09-12-Architecture-Review-Board.md#Discussed | none | idempotency-keys led by ea-standards/Drafts/Idempotency-Keys-v2-DRAFT.md; ea-standards/Drafts/Idempotency-Keys-v2-DRAFT.md leads; idempotency-keys: not listed; internal-tls: not listed |
| 12 sources, planted pages | 1.5 | after | 1.00 | 0.25 | none | 3: replay-failed-refund, internal-tls, authorisation-checks | none | none |
| 12 sources, planted pages | 1.5 | before | 1.00 | 0.13 | none | 7: cloud-run-timeouts, replay-failed-refund, payments-api-conventions, payments-team/SitePages/Idempotency.md#How long we keep keys, … | cloud-run-timeouts | none |
| 12 sources, planted pages | 2.1 | after | 1.00 | 0.67 | none | 1: idempotency-keys | none | none |
| 12 sources, planted pages | 2.1 | before | 1.00 | 0.67 | none | 1: idempotency-keys | none | none |
| 12 sources, planted pages | 2.2 | after | 1.00 | 0.33 | none | 2: payments-api-conventions, ea-standards/Meeting-notes/2026-09-12-Architecture-Review-Board.md#Discussed | none | none |
| 12 sources, planted pages | 2.2 | before | 1.00 | 0.25 | none | 3: replay-failed-refund, payments-api-conventions, ea-standards/Meeting-notes/2026-09-12-Architecture-Review-Board.md#Discussed | none | idempotency-keys led by ea-standards/Drafts/Idempotency-Keys-v2-DRAFT.md; idempotency-keys: not listed |
| 12 sources, planted pages | 3.1 | after | 1.00 | 0.40 | none | 3: payments-api-conventions, idempotency-keys, internal-tls | none | none |
| 12 sources, planted pages | 3.1 | before | 1.00 | 0.33 | none | 4: payments-api-conventions, ea-standards/Drafts/Idempotency-Keys-v2-DRAFT.md#Keeping the key, internal-tls, openshift-route-timeouts | openshift-route-timeouts | none |
| 12 sources, planted pages | 3.2 | after | 1.00 | 0.33 | none | 2: caller-customer-check, api-resource-naming | none | none |
| 12 sources, planted pages | 3.2 | before | 1.00 | 0.33 | none | 2: caller-customer-check, api-resource-naming | none | none |
| 12 sources, planted pages | 4.1 | after | 1.00 | 0.50 | none | 2: ea-standards/Meeting-notes/2026-09-12-Architecture-Review-Board.md#Discussed, event-principles | none | none |
| 12 sources, planted pages | 4.1 | before | 1.00 | 0.50 | none | 2: ea-standards/Meeting-notes/2026-09-12-Architecture-Review-Board.md#Discussed, event-principles | none | internal-tls: none suggested |
| 12 sources, planted pages | 4.2 | after | 1.00 | 1.00 | none | none | none | none |
| 12 sources, planted pages | 4.2 | before | 1.00 | 1.00 | none | none | none | none |
| 12 sources, planted pages | 5.1 | after | 1.00 | 1.00 | none | none | none | none |
| 12 sources, planted pages | 5.1 | before | 1.00 | 0.67 | none | 1: orders-team/api/api-errors.md#The error body | none | none |
| 12 sources, planted pages | 5.2 | after | 1.00 | 1.00 | none | none | none | none |
| 12 sources, planted pages | 5.2 | before | 1.00 | 0.33 | none | 2: payments-api-conventions, orders-team/api/api-errors.md#The error body | none | none |
| 12 sources, planted pages | 6.1 | after | 1.00 | 0.50 | none | 2: glossary-reference/terms/refund.md#Definition, replay-failed-refund | none | none |
| 12 sources, planted pages | 6.1 | before | 1.00 | 0.40 | none | 3: glossary-reference/terms/refund.md#Definition, payments-api-conventions, replay-failed-refund | none | none |
| 12 sources, filler at scale 1 | 1.1 | after | 1.00 | 0.50 | none | 3: idempotency-keys, glossary-reference/acronyms/Refund-report-term-466.md#Overview, identity-team/retros/How-we-request-the-refund-reconciliation-39.md#Known issues | none | none |
| 12 sources, filler at scale 1 | 1.1 | before | 1.00 | 0.43 | none | 4: idempotency-keys, glossary-reference/acronyms/Refund-report-term-466.md#Overview, identity-team/retros/How-we-request-the-refund-reconciliation-39.md#Known issues, angular-form-validation | none | none |
| 12 sources, filler at scale 1 | 1.2 | after | 1.00 | 0.17 | none | 5: glossary-reference/acronyms/Refund-report-term-466.md#Details, api-resource-naming, anvil-framework/data/Testing-a-refund-report-247.md#Who to ask, orders-team/api/api-errors.md#The error body, … | none | none |
| 12 sources, filler at scale 1 | 1.2 | before | 1.00 | 0.13 | none | 7: payments-api-conventions, stock-team/notes/Currency-table-FAQ-30.md#History, api-resource-naming, anvil-framework/data/Testing-a-refund-report-247.md#Who to ask, … | none | none |
| 12 sources, filler at scale 1 | 1.3 | after | 1.00 | 0.40 | none | 3: openshift-platform/monitoring/Refund-report-on-the-platform-34.md#Details, api-resource-naming, ea-standards/Standards/Using-refund-reconciliations-655.md#Known issues | none | none |
| 12 sources, filler at scale 1 | 1.3 | before | 1.00 | 0.40 | none | 3: anvil-framework/events/Testing-a-refund-report-206.md#Who to ask, api-resource-naming, ea-standards/Standards/Using-refund-reconciliations-655.md#Known issues | none | order-events-v2 led by orders-team/events/order-events-v1.md; orders-team/events/order-events-v1.md leads |
| 12 sources, filler at scale 1 | 1.4 | after | 0.50 | 0.25 | internal-tls | 3: replay-failed-refund, ea-standards/Meeting-notes/2026-09-12-Architecture-Review-Board.md#Discussed, identity-team/retros/Notes-on-the-payment-method-27.md#Steps | none | internal-tls: not listed |
| 12 sources, filler at scale 1 | 1.4 | before | 0.50 | 0.20 | internal-tls | 4: replay-failed-refund, ea-standards/Meeting-notes/2026-09-12-Architecture-Review-Board.md#Discussed, identity-team/retros/Notes-on-the-payment-method-27.md#Steps, warehouse-link-tls-exception | warehouse-link-tls-exception | idempotency-keys led by ea-standards/Drafts/Idempotency-Keys-v2-DRAFT.md; ea-standards/Drafts/Idempotency-Keys-v2-DRAFT.md leads; idempotency-keys: not listed; internal-tls: not listed |
| 12 sources, filler at scale 1 | 1.5 | after | 1.00 | 0.17 | none | 5: replay-failed-refund, anvil-framework/config/Request-timeout-dashboard-recipes-8.md#Steps, anvil-framework/config/Testing-a-on-call-rota-118.md#Details, orders-team/retros/Retro-the-resource-tag-124.md#Overview, … | none | none |
| 12 sources, filler at scale 1 | 1.5 | before | 1.00 | 0.13 | none | 7: payments-team/SitePages/Idempotency.md#How long we keep keys, replay-failed-refund, payments-api-conventions, anvil-framework/config/Request-timeout-dashboard-recipes-8.md#Steps, … | cloud-run-timeouts | none |
| 12 sources, filler at scale 1 | 2.1 | after | 1.00 | 0.50 | none | 2: idempotency-keys, identity-team/notes/Notes-on-the-refund-reconciliation-1.md#How it works | none | none |
| 12 sources, filler at scale 1 | 2.1 | before | 1.00 | 0.50 | none | 2: idempotency-keys, identity-team/notes/Notes-on-the-refund-reconciliation-1.md#How it works | none | none |
| 12 sources, filler at scale 1 | 2.2 | after | 1.00 | 0.33 | none | 2: payments-api-conventions, ea-standards/Meeting-notes/2026-09-12-Architecture-Review-Board.md#Discussed | none | none |
| 12 sources, filler at scale 1 | 2.2 | before | 1.00 | 0.20 | none | 4: replay-failed-refund, payments-api-conventions, ea-standards/Meeting-notes/2026-09-12-Architecture-Review-Board.md#Discussed, orders-team/api/api-errors.md#The error body | none | idempotency-keys led by ea-standards/Drafts/Idempotency-Keys-v2-DRAFT.md; idempotency-keys: not listed |
| 12 sources, filler at scale 1 | 3.1 | after | 1.00 | 0.50 | none | 2: payments-api-conventions, idempotency-keys | none | none |
| 12 sources, filler at scale 1 | 3.1 | before | 1.00 | 0.33 | none | 4: payments-api-conventions, idempotency-keys, openshift-platform/deploy/How-to-review-a-refund-report-221.md#History, openshift-platform/deploy/On-call-rota-limits-421.md#How it works | none | none |
| 12 sources, filler at scale 1 | 3.2 | after | 1.00 | 0.33 | none | 2: api-resource-naming, caller-customer-check | none | none |
| 12 sources, filler at scale 1 | 3.2 | before | 1.00 | 0.33 | none | 2: api-resource-naming, caller-customer-check | none | none |
| 12 sources, filler at scale 1 | 4.1 | after | 1.00 | 0.25 | none | 6: glossary-reference/terms/refund.md#Definition, stock-team/warehouse/Load-balancer-FAQ-348.md#Overview, stock-team/warehouse/How-we-move-the-warehouse-slot-284.md#History, openshift-platform/deploy/How-to-review-a-refund-report-221.md#History, … | none | none |
| 12 sources, filler at scale 1 | 4.1 | before | 1.00 | 0.25 | none | 6: payments-team/SitePages/Return-label-FAQ-132.md#How it works, anvil-framework/data/Refund-report-recipes-292.md#How it works, glossary-reference/terms/refund.md#Definition, stock-team/warehouse/Load-balancer-FAQ-348.md#Overview, … | none | internal-tls: none suggested |
| 12 sources, filler at scale 1 | 4.2 | after | 1.00 | 0.33 | none | 2: security-standards/tls/Log-shipping-standard-113.md#How it works, ea-standards/Principles/Log-shipping-principles-631.md#Steps | none | none |
| 12 sources, filler at scale 1 | 4.2 | before | 1.00 | 0.25 | none | 3: web-framework/forms/Return-label-with-the-framework-220.md#History, security-standards/tls/Log-shipping-standard-113.md#How it works, ea-standards/Principles/Log-shipping-principles-631.md#Steps | none | none |
| 12 sources, filler at scale 1 | 5.1 | after | 1.00 | 0.33 | none | 4: ea-standards/Principles/Using-status-pages-281.md#How it works, openshift-platform/deploy/Status-page-limits-116.md#Known issues, web-framework/components/Status-page-recipes-2023-56.md#Steps, web-framework/components/Status-page-with-the-framework-76.md#Overview | none | none |
| 12 sources, filler at scale 1 | 5.1 | before | 1.00 | 0.25 | none | 6: orders-team/api/api-errors.md#The error body, ea-standards/Principles/Using-status-pages-281.md#How it works, gcp-platform/pubsub/How-to-archive-a-status-page-8.md#Steps, openshift-platform/deploy/Status-page-limits-116.md#Known issues, … | none | none |
| 12 sources, filler at scale 1 | 5.2 | after | 1.00 | 1.00 | none | none | none | none |
| 12 sources, filler at scale 1 | 5.2 | before | 1.00 | 0.33 | none | 2: orders-team/api/api-errors.md#The error body, payments-api-conventions | none | none |
| 12 sources, filler at scale 1 | 6.1 | after | 1.00 | 0.33 | none | 4: glossary-reference/terms/refund.md#Definition, anvil-framework/testing/Testing-a-customer-profile-19.md#History, glossary-reference/terms/Customer-profile-term-18.md#Details, replay-failed-refund | none | none |
| 12 sources, filler at scale 1 | 6.1 | before | 1.00 | 0.25 | none | 6: glossary-reference/terms/refund.md#Definition, payments-api-conventions, payments-team/SitePages/Runbooks/Customer-profile-FAQ-268.md#Who to ask, anvil-framework/testing/Testing-a-customer-profile-19.md#History, … | none | none |

## Keeping a task's knowledge by words and meaning (ADR 0132 addendum)

Written on 2026-10-27 from `runManyWikisBench` with the pinned model (all-MiniLM-L6-v2, every node embedded first), the "after" selection (authority, scope and status on). Words, no model: the keep test as the tables above measure it (the test suites run with `ATTICUS_EMBEDDINGS=off`). Words, model on: the same keep test, with the model ranking the search (`keep: "words"`). Words and meaning: two of the words a task changes, or one of its names, keep a page; one common word only with a cosine of at least 0.65 to the task's step; none, only at 0.65. Time: one task's selection on its own, as `atticus task context` makes it, on average over the 14 tasks (index opened each time), on the 2-CPU build machine.

| Run | Keep test | Recall | Precision | Never | Leads | One task |
| --- | --- | --- | --- | --- | --- | --- |
| 12 sources, planted pages (32 pages) | words, no model | 0.96 | 0.50 | 0 | 5 / 5 | 37 ms |
| 12 sources, planted pages (32 pages) | words, model on | 0.96 | 0.46 | 0 | 5 / 5 | 47 ms |
| 12 sources, planted pages (32 pages) | words and meaning | 0.96 | 0.58 | 0 | 5 / 5 | 43 ms |
| 12 sources, filler at scale 1 (4832 pages) | words, no model | 0.96 | 0.34 | 0 | 5 / 5 | 1.31 s |
| 12 sources, filler at scale 1 (4832 pages) | words, model on | 0.96 | 0.31 | 0 | 5 / 5 | 1.47 s |
| 12 sources, filler at scale 1 (4832 pages) | words and meaning | 0.96 | 0.51 | 0 | 5 / 5 | 1.42 s |

Embedding every node at scale 1 (once, `atticus index embed`): about 210 s. The planted run with the model is replayed in CI from `fixtures/retrieval/vectors/benches/all-minilm-l6-v2.json` (`packages/evals/test/many-wikis-bench.test.ts`).

What is left at 4,800 pages: filler sections that share two common words with a task ("refund", "report", "warehouse", "link") and the pages naming the component a task calls are still kept; task 1.4's TLS standard is still not offered by the search.
