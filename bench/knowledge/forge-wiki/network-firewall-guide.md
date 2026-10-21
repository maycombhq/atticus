---
title: Network team guide to firewall rules
space: NETWORK
tags: [platform-runbook, security-standard]
owner: Network team
last-updated: 2026-02-17
---

# Network team guide to firewall rules

## What we accept

- Rules name one source workload and one destination; we do not accept any-to-any rules or whole subnets.
- Vendor destinations are given by DNS name, never by IP address.
- Only ports 443 and 8443 are opened to vendors; anything else needs a Security Architecture exception.

## Turnaround

Standard firewall rules are implemented within 5 working days.

## Reviews

Every rule is reviewed once a year with its owner team, and rules nobody claims are removed.
