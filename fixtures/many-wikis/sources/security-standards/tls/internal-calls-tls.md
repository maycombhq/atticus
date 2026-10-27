---
title: Internal calls use TLS 1.3
owner: Security Architecture
updated: 2026-06-01
---
# Internal calls use TLS 1.3

## The rule

- Every call between Forge services uses TLS 1.3 with mutual authentication.
- A service refuses a connection that offers only TLS 1.2 or older.
