---
title: Platform logging runbook
space: PLATFORM
tags: [platform-runbook]
owner: Platform Operations
last-updated: 2026-03-03
---

# Platform logging runbook

## Where logs go

The platform collector picks up every container's standard output and ships it to the log store. Search by correlationId to follow one request across services.

## How long we keep them

- Application logs are kept for 90 days.
- Audit records are kept for 2 years in the audit store, then deleted.

## When the collector falls behind

Page the Platform Operations on-call. Do not restart the collector during month-end.
