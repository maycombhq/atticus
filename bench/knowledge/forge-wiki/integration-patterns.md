---
title: Integration patterns
space: ENGARCH
tags: [integration-patterns, enterprise-architecture]
owner: Enterprise Architecture
last-updated: 2026-08-14
---

# Integration patterns

Every connection between two Forge systems, or between Forge and a vendor, uses one of the four patterns on this page. Pick the first one that fits. A design that needs something else goes to the Enterprise Architecture review before any story is written.

## P1: Synchronous call through the internal gateway

Use this when a service needs an answer from another Forge service inside the same user request.

- Every call between Forge services goes through the internal API gateway; no service calls another service's host directly.
- The caller sets a timeout under 3 seconds and wraps the call in a circuit breaker.
- The gateway checks an OAuth2 client-credentials token; each calling service has its own client id.
- A new route on the internal gateway needs a Gateway route request from the service desk catalogue.
- The caller passes the X-Forge-Correlation-Id header on every call.

## P2: Events through the broker

Use this when other systems need to know that something happened and the producer does not need an answer.

- Every topic has a schema in the schema registry before the first event is published.
- Every consumer has a dead-letter topic named after its topic with the suffix .dlq.
- Every event carries an event id, and consumers must handle the same event twice without harm.
- Fields classified Restricted never go on the broker.
- Topic names follow forge.<domain>.<event>.v<major>.
- A new topic needs a Broker topic request from the service desk catalogue.

## P3: File transfer

Use this only when a partner can exchange nothing but files, or when a batch moves more than 50 MB at a time no more often than daily.

- All file transfers go through Harbour MFT, the managed file transfer service.
- Every file is encrypted with the receiving party's PGP key before it leaves Forge.
- No new routes are accepted on the Courier file hub; see Architecture decisions.
- Each new transfer needs an MFT route request from the service desk catalogue.

## P4: Vendor through the partner gateway

Use this when a Forge service calls a vendor's API or a vendor calls Forge.

- All vendor traffic goes through the partner gateway; services never open connections to vendor hosts directly.
- The partner gateway authenticates to the vendor with mTLS or OAuth2, and the credentials live in the gateway vault, never in service configuration.
- Every retry of a call that changes state carries an idempotency key.
- A vendor host that is not yet in the approved vendor register needs the vendor onboarding process first.

## Not a pattern: reading another service's database

A service never reads or writes another service's database. Reporting jobs read through the owning service's API or consume its events.
