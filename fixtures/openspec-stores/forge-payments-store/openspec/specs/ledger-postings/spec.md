# ledger-postings Specification

## Purpose ##

```text
## Purpose
not this one: it is inside a code block
```

Every Forge transfer posts a debit and a credit to the ledger.

## Requirements

### Requirement: Balanced postings

The system SHALL post a debit and a credit of the same amount for every transfer.

#### Scenario: a transfer settles

- **WHEN** a transfer settles
- **THEN** the ledger holds a debit and a credit of its amount
