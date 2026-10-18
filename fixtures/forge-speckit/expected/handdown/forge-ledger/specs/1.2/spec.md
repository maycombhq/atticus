# Feature Specification: Check the limit in the transfer transaction, with tests

**Feature Branch**: `task/add-transfer-limit/1.2`
**Created**: 2026-10-19
**Status**: Draft
**Input**: Task 1.2 of change add-transfer-limit (Add a daily transfer limit)

<!-- Handed down by Atticus from openspec/changes/add-transfer-limit: stories/s1-refuse-over-limit.md. Refine it with /speckit.specify and /speckit.clarify. A question that needs the change's design goes back up, never into this repo alone. -->

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Refuse transfers over the daily limit (Priority: P1)

As a Portal customer I want transfers over my daily limit refused so that a stolen login can't
drain my account.

**Acceptance Scenarios**:

1. **Given** an account with a limit of 1000 that has sent 900 today, **When** it asks to send 200, **Then** the transfer is refused with LIMIT_EXCEEDED and nothing is posted.
2. **Given** an account with a limit of 1000 that has sent 900 today, **When** it asks to send 100, **Then** the transfer is accepted.

### Edge Cases

- [NEEDS CLARIFICATION: cases the story's acceptance criteria don't cover]

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST meet acceptance scenario 1 of User Story 1.
- **FR-002**: System MUST meet acceptance scenario 2 of User Story 1.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every acceptance scenario above passes as an automated test.
