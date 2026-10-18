## ADDED Requirements

### Requirement: Daily transfer limit
The system SHALL refuse a transfer that would take an account's outgoing total for the day over its daily limit.

#### Scenario: Transfer over the limit
- **WHEN** an account with a limit of 1000 has sent 900 today and asks to send 200
- **THEN** the transfer is refused with error LIMIT_EXCEEDED and nothing is posted

#### Scenario: Transfer within the limit
- **WHEN** an account with a limit of 1000 has sent 900 today and asks to send 100
- **THEN** the transfer is accepted

### Requirement: Remaining limit
The system SHALL return how much of today's limit an account has left.

#### Scenario: Remaining limit after transfers
- **WHEN** an account with a limit of 1000 has sent 900 today
- **THEN** GET /accounts/{id}/limit returns limit 1000 and remaining 100
