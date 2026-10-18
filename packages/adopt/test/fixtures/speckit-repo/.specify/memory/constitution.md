# Order Export Constitution

## Core Principles

### I. Test-First (NON-NEGOTIABLE)

Every acceptance criterion has a failing test before the code that makes it pass. Pull requests without tests for new behaviour are not merged.

### II. Contracts Before Code

Every new or changed HTTP endpoint is described in an OpenAPI contract under `contracts/` before it is implemented, and the contract is reviewed with its callers.

### III. Observability

Every outbound call logs its target, duration and outcome, and every service exposes a health endpoint and alerts on error rate.

### IV. No Secrets In The Repo

Credentials, tokens and keys never appear in source, configuration or test data; they come from the platform's secret store.

### V. Data Retention

Every new table states how long its rows are kept and how they are deleted.

## Additional Constraints

Services run on the shared container platform and use the approved base images.

## Governance

This constitution supersedes other practices. Amendments need the tech lead's approval and a migration plan.

**Version**: 1.2.0 | **Ratified**: 2026-03-01 | **Last Amended**: 2026-08-15
