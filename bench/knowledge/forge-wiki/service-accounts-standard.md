---
title: Service accounts standard
space: SECURITY
tags: [security-standard]
owner: Identity and Access team
last-updated: 2026-04-21
---

# Service accounts standard

## Rules

- Each workload gets its own service account in each environment.
- Service accounts cannot log in interactively.
- Workloads on the Kubernetes platform use workload identity; any service account password is rotated every 90 days.
- A service account gets the least access its workload needs, and read-only database access unless writes are justified.
