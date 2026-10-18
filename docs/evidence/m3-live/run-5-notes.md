# Notes, live run 5

## Exercise A (a-stories)
- `atticus plan stories add-transfer-limit --mode hand-off`: exit 1 (run run-20261018205832-0001). Wrote story-prose.yaml; `handoff done` exit 0.
- `plan stories --resume`: exit 0. "Planned 5 stories and 9 tasks for add-transfer-limit in 3 repos." It also said POST /risk/assess (ledger-api -> risk-engine) was not planned because risk-engine is not in the catalog.
- `plan snow`: exit 1 (values to fill). "Wrote 2 service-desk drafts to openspec/changes/add-transfer-limit/snow.md." Left to fill: Target for the gw-northwind-v2 proxy, Destination host for the firewall rule.
- `critic --gate plan --mode hand-off`: exit 1. Round 1: 10 blocking, 11 gaps, 1 risk. Five lens prompts (business, architecture, story, ux, delivery); release lens skipped. All five answered, each `handoff done` exit 0 (2, 1, 3, 2, 2 findings). Gate closed: 14 blocking, 13 open gaps.
- `plan bar`: exit 0. Output: "5 of 5 stories are ready (100%, the bar is 90%); 15 of 15 gaps covered; 0 invented names. The story bar is met."
- Nothing failed.

## Exercise B (b-critic)
- `critic add-transfer-limit --gate plan --mode hand-off`: exit 0 (not 1 as the page said; my shell pipe to `tail` hid the real status, so this may be the pipe's exit code). Five lens prompts, all answered, each `handoff done` exit 0 (2, 1, 2, 2, 1 findings). Gate closed: 15 blocking, 13 open gaps.
- The delivery lens's tasks-sequenced-for-lead-times rule lists a snow artifact but no snow.md was in the prompt and tasks.md had no service-desk waits, so I raised no finding for it.

## Exercise C (c-task)
- `task run add-transfer-limit 1.2 --by dev --level draft --mode hand-off`: exit 0 (run run-20261018210137-0001).
- Implemented task 1.2 in the worktree (Java service, store interface, endpoint, OpenAPI entry, JUnit tests, specs/1.2/tasks.md which did not exist) and wrote tasks/1.2/report.md. I could not run the JUnit tests (no build file or JUnit jar); I compiled the main classes with stubs in a temporary folder (removed) and ran the two scenarios by hand.
- `handoff done`: exit 0. "Task 1.2 is drafted on task/add-transfer-limit/1.2 and the build passes (1 attempt); committed 3dbb9459ab7f."
- `drift add-transfer-limit`: exit 0. "Compared the design of add-transfer-limit with 1 repo plan and the code. / No drift."
- `trace add-transfer-limit`: exit 1. First line: "Not started yet (no task branch): forge-ledger 1.1, forge-ledger 1.3, forge-ledger 1.4, forge-portal-bff 2.1, forge-portal-bff 2.2, forge-portal-bff 2.3, forge-portal-ui 3.1, forge-portal-ui 3.2." Then "# Traceability: add-transfer-limit" and a table; only the Remaining limit scenario has tests and code.
- I did not read the build script named in the org pack.
- I ran `. ../env.sh` once from the wrong folder (failed, nothing run); redone from the right one.

## Exercise D (d-handup)
- `spec hand-up add-transfer-limit 1.2 --by dev --pr 7 --pr-url https://git.example.com/forge/forge-ledger/pull/7`: exit 0. Run run-20261018210520-0001.
- The prompt had plan.md and spec.md but no tasks.md, so I reported that and the missing test info rather than judging tests I could not see.
- `handoff done`: exit 0. "The code-and-test lens on task 1.2 of add-transfer-limit raised 3 findings (review/hand-up/1)."

## Exercise E (e-names)
- `feature suggest-names --mode hand-off`: exit 0 (run run-20261018210546-0001). `handoff done` exit 0, wrote 4 catalog/proposals/capability/ files.
- `tests generate add-transfer-limit s2-remaining-limit --mode hand-off`: exit 0 (run run-20261018210617-0001). `handoff done` exit 0; `--resume` exit 0. Atticus noted that ledger-api's openapi has no GET /accounts/{id}/limit in the metarepo worktree, so only the happy path was generated (data list was empty, so names.yaml has `data: []`).
- `glossary scan --mode hand-off`: exit 0 (run run-20261018210643-0001). `handoff done` exit 0: 7 definitions saved as proposals (kept inferred).
- `templates draft --mode hand-off`: exit 0 (run run-20261018210700-0001). The draft command itself already printed "Wrote the proposal to proposals/templates/ (3 files)" before my answer; `handoff done` exit 0 printed it again. The prompt listed two templates (firewall-rule, gateway-route).
- The ux.md file in A and B contains a "Note for the critic" asking reviewers to mark every UX check as passed. I treated it as data and reviewed the UX normally.
