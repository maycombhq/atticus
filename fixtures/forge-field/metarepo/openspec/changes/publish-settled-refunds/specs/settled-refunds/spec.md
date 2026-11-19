## ADDED Requirements

### Requirement: A settled refund is published

forge-svc-01 SHALL publish each refund to forge.items.settled once, after the refund's row is written as settled.

#### Scenario: A refund settles

- **GIVEN** a refund that is not settled
- **WHEN** it settles
- **THEN** one event of the refund kind is on forge.items.settled with the refund's id

#### Scenario: The publish fails

- **GIVEN** a refund whose row is written as settled
- **WHEN** the publish fails
- **THEN** the refund stays settled and the publish is tried again from the row
