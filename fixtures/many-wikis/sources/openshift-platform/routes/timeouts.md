---
title: Route and call timeouts on OpenShift
owner: OpenShift Platform team
updated: 2026-08-12
---
# Route and call timeouts on OpenShift

## Timeouts

- A call from a service on OpenShift to another service sets a timeout of its own, in the service's configuration, never in code.
- The route's timeout annotation is longer than the longest call timeout of the service behind it.
