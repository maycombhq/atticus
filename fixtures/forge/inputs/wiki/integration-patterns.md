# Integration patterns

Every hop on an architecture diagram carries one of these codes.

| Code | Name | Interaction | Required controls |
| --- | --- | --- | --- |
| S.GW.SOR | Synchronous via the gateway to a system of record | sync | OAuth2 at the gateway, timeout under 3 s, circuit breaker |
| S.GW.VND | Synchronous via the gateway to a vendor | sync | OAuth2 or mTLS at the gateway, timeout, retry with idempotency key |
| S.DIR.BFF | Synchronous, direct from a UI to its own BFF | sync | Session auth |
| A.EB.PUB | Asynchronous publish to the event bus | async | Schema in the registry, dead-letter topic |
| D.JDBC | Direct database access | data-access | Read-only account, owner approval |
