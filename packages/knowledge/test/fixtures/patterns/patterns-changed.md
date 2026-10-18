# Integration patterns (draft)

Every hop on an architecture diagram carries one of these codes.

| Code | Name | Interaction | Required controls |
| --- | --- | --- | --- |
| S.GW.SOR | Synchronous via the gateway to a system of record | sync | OAuth2 at the gateway, timeout under 2 s, circuit breaker |
| S.GW.VND | Synchronous via the gateway to a vendor | sync | OAuth2 or mTLS at the gateway, timeout, retry with idempotency key |
| S.DIR.BFF | Synchronous, direct from a UI to its own BFF | sync | Session auth |
| A.EB.PUB | Asynchronous publish to the event bus | async | Schema in the registry, dead-letter topic |
| F.SFTP.VND | File transfer over SFTP to a vendor | async | PGP-encrypted files, checksum file |
