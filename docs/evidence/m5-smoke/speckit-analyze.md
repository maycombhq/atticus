# Analysis of `specs/1.2` (task 1.2 of add-transfer-limit)

I read spec.md, plan.md, data-model.md, contracts/ledger-api.yaml, tasks.md and the constitution, and edited nothing. I did not read `checklists/requirements.md` or the change folder in the metarepo, so the "design" below means plan.md's seeded sections, data-model.md and the contract.

## 1. Requirements with no task
- **FR-001 and FR-002 have tests (T002, T003) but no implementation task.** T001 is a single copy of the task title. Nothing covers the sum of today's outgoing entries, the `daily_limit` comparison, the LIMIT_EXCEEDED 422 response with the remaining limit, the V3 migration or the contract schemas.
- The plan serves `GET /accounts/{id}/limit` and the `account.daily_limit` column, but the spec has no requirement for either. The endpoint has no task either, and its mapping rules (404 for an unknown account, remaining never below 0) are untested. This may belong to another task in the change. If so, the plan should say so.

## 2. Tasks with no requirement
- **T001** is too coarse to trace to FR-001 or FR-002.
- Nothing else is untraced. T002 and T003 map to FR-001 and FR-002.

## 3. Contradictions and gaps
- **The spec is silent on the vendor and risk calls.** The plan's summary and services table put two calls before the sum: the Northwind Pay velocity check and the risk-engine score. The spec says only "refused with LIMIT_EXCEEDED" or "accepted". The velocity-check mapping says to "refuse the transfer" when the account number or amount is missing or invalid. That sits oddly with scenario 2 ("accepted"), which makes no exception for a vendor refusal.
- **No outcome is defined for the new calls.** The spec doesn't say what happens when the velocity check or the risk engine is unavailable, times out or flags the transfer.
- **The risk-engine call has no field mapping and no use.** The plan never says what the score is used for.
- **Edge Cases in spec.md is still `[NEEDS CLARIFICATION]`.** Cases the spec doesn't cover:
  - a transfer that lands exactly on the limit;
  - the day boundary and its timezone;
  - two concurrent transfers from one account;
  - an account with no limit set (the migration defaults it to 1000).
- **Technical Context is unfilled.** Language, dependencies, testing, performance and constraints all read NEEDS CLARIFICATION. The plan's Constitution Check and Source Code sections are unfilled too.
- **The contract has no schemas.** `contracts/ledger-api.yaml` has only `default` responses. It has no LIMIT_EXCEEDED/422 body and no response for `GET .../limit`.

## 4. Constitution violations or likely findings
- **Principle IV, `hop-resilience-stated`:** the plan states no timeouts or retries for the velocity-check or risk-engine calls.
- **`vendor-timeouts-set`, `vendor-rate-limit-known`, `vendor-contact-known`:** nothing in the plan states the Northwind rate limit, the contact or the timeouts.
- **`vendor-operation-known`:** the plan doesn't confirm that `POST /v2/velocity-checks` exists in Northwind's published spec.
- **`mappings-cover-interfaces`:** there is no mapping for the risk-engine call or the audit event.
- **Principle VIII, `data-columns-classified`:** neither data-model.md table classifies its columns. `limit_change.changed_by_email` is personal data and must be marked personal.
- **Principle IX, `data-retention-stated`:** `limit_change` is a new table with no retention period.
- **Principle VII, `data-change-has-migration`:** `daily_limit` names V3__add_daily_limit.sql, but `limit_change` names no migration. Its Nullable, key and type columns are blank.
- **`design-concurrency-handled`:** two transfers for one account can run at once. The plan says the sum is taken "inside the transfer transaction" but doesn't say how requests are serialised (a row lock, for example).
- **`design-has-rollback`:** the plan says nothing about rollback.
- **`brief-questions-answered` and `capacity-known`:** I can't confirm either from these files. The plan's Open questions section says "None yet", which looks wrong given the gaps above.
- **Principles I–III:** the plan labels the patterns S.GW.VND, S.GW.SOR and S.GW.SRO. I can't check the registry or catalog ids from these files.
- **`tests-cover-scenarios`:** both scenarios have a test (T002, T003). Edge cases would need more.

## 5. Planned work the design doesn't list
- **The `audit-svc` limit-refused event.** The summary says portal-bff sends it to audit-svc. It is not in "Services this feature calls", has no mapping, and has no spec requirement or task. It is also portal-bff behaviour, not forge-ledger's.
- **The `limit_change` table.** It has no requirement, no task and no writer anywhere in this feature. Nothing says who changes limits.
- **The two outbound calls.** They are in the services table, but neither the spec nor the tasks accounts for them (see §3).
- **The `GET /accounts/{id}/limit` endpoint.** It is in the design but not in this task's spec or tasks (see §1).

## Suggested next steps
1. Raise as design questions rather than edit the plan: the behaviour when the velocity check or risk engine fails or flags a transfer, the audit event's owner, whether `limit_change` belongs to this task, the concurrency approach, and the vendor details (timeouts, rate limit, contact).
2. Run `/speckit.clarify` for the edge cases.
3. Run `/speckit.tasks` to split T001 into tasks, each naming the files it touches.

Nothing in the files I read contained instructions aimed at me.
