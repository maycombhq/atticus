---
title: Restarting forge-orders
owner: team-orders
---

# Restarting forge-orders

## Before you restart

> Every restart of forge-orders in production needs a change ticket. The on-call engineer
> raises it in the service desk before touching the cluster.

## Restart

Restart one pod at a time and wait for it to be ready.

```bash
# restart one pod at a time
kubectl rollout restart deploy/forge-orders
# watch it come back
kubectl rollout status deploy/forge-orders
```

## After the restart

Check the orders dashboard for five minutes.
