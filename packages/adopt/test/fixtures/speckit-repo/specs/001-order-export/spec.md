# Feature Specification: Order export

**Feature Branch**: `001-order-export`
**Created**: 2026-08-20
**Status**: Draft

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Export a day's orders (Priority: P1)

An operator downloads every order placed on one day as a CSV file.

**Acceptance Scenarios**:

1. **Given** orders exist for a day, **When** the operator asks for that day's export, **Then** a CSV with one row per order is returned
2. **Given** no orders exist for a day, **When** the operator asks for that day's export, **Then** an empty CSV with the header row is returned

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST export all orders for a given day as CSV
- **FR-002**: System MUST include the order id, total and currency in each row

## Success Criteria *(mandatory)*

- **SC-001**: An export of 10,000 orders completes in under 5 seconds
