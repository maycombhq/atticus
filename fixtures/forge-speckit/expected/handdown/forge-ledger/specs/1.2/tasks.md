# Tasks: Check the limit in the transfer transaction, with tests

**Input**: spec.md and plan.md in this folder (task 1.2 of change add-transfer-limit)

<!-- Seeded by Atticus at hand-down. Refine it with /speckit.tasks; tick each box as you finish it. -->

## Implementation

- [ ] T001 Check the limit in the transfer transaction, with tests

## Tests

- [ ] T002 [s1-refuse-over-limit] Test: Given an account with a limit of 1000 that has sent 900 today, when it asks to send 200, then the transfer is refused with LIMIT_EXCEEDED and nothing is posted.
- [ ] T003 [s1-refuse-over-limit] Test: Given an account with a limit of 1000 that has sent 900 today, when it asks to send 100, then the transfer is accepted.
