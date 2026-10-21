---
title: Encryption standard
space: SECURITY
tags: [security-standard]
owner: Security Architecture
last-updated: 2026-04-08
---

# Encryption standard

## In transit

- All traffic uses TLS 1.2 or later, including traffic inside the Forge network; TLS 1.3 is preferred.
- Internal hosts use certificates from the Forge internal PKI; public hosts use certificates the PKI team obtains from the public certificate authority.
- Self-signed certificates are not allowed in production.

## At rest

- Every database and file store is encrypted at rest.
- Restricted fields also get column-level encryption with keys held in the key management service.
- Encryption keys are rotated at least once a year.

## Banned

- TLS 1.0, TLS 1.1 and SHA-1 signatures are banned everywhere.
