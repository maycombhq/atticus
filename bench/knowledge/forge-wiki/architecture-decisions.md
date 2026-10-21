---
title: Architecture decisions
space: ENGARCH
tags: [enterprise-architecture]
owner: Enterprise Architecture
last-updated: 2026-09-30
---

# Architecture decisions

Decisions the architecture board has made that bind every team. Each one stays in force until a later decision replaces it.

## AD-07: New backend services use Anvil

Status: mandated. Every new backend service is built on Anvil 3; other frameworks need an architecture board exception.

## AD-11: The Courier file hub is retired

Status: retiring. No new routes on the Courier file hub from 1 July 2026; every route moves to Harbour MFT and Courier is switched off on 31 March 2027.

## AD-14: No shared service accounts

Status: banned. A service account belongs to one workload in one environment; accounts shared between workloads are removed at the next review.

## AD-15: No reads from another service's database

Status: banned. A service never connects to a database owned by another service, even read-only; use the owning service's API or its events.

## AD-19: Kiln 1 is retired

Status: retiring. Screens still on Kiln 1 must move to Kiln 2 by 31 December 2026, when Kiln 1 loses support.

## AD-22: No vendor calls from a browser

Status: banned. A browser never calls a vendor host; vendor calls go from a backend service through the partner gateway.
