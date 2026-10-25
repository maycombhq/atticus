# refunds Specification

## Purpose

Refunds of settled Forge transfers, back to the account that paid.

## Requirements

### Requirement: Refund a settled transfer

The system SHALL refund a settled transfer to the paying account.

#### Scenario: a refund is asked for

- **WHEN** a customer asks for a refund of a settled transfer
- **THEN** the amount goes back to the paying account
