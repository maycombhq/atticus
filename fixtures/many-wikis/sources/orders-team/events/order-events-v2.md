---
title: Order events (v2)
owner: Orders team
updated: 2026-07-01
---
# Order events (v2)

## Publishing order events

- An order service publishes order events to the order-events topic as JSON, after the order is saved.
- An event's type names what happened in the past tense, such as order-refunded.
