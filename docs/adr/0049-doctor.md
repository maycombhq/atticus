# 0049. atticus doctor: what this machine needs (C4, additive)

- Status: accepted
- Date: 2026-10-19

## Context

Installs fail on the machine, not in Atticus: an old Node, Git without long paths on Windows, a proxy that inspects TLS with no root certificate configured, a metarepo on a read-only share, the app's port taken. Each showed up as a confusing error deep inside another command. ADR 0047 promised these checks on the setup checklist.

## Decision

- **`atticus doctor [--json]`** runs a fixed set of checks and prints each as ok, warn or FAIL with a plain fix: Node (22.13 or later), Git (2.30 or later), Git identity, long paths (Windows), line endings, the bundled OpenSpec CLI, proxy variables and a localhost bypass, `NODE_EXTRA_CA_CERTS` (a readable PEM file), the metarepo is writable, free disk, the app's port, the org pack, the assistant and editor `runtime.yaml` allows, and which outside systems are live. Exit 0 when nothing fails; warnings don't fail.
- It reads the machine and the metarepo only: **no network call and no AI**, and it **never prints a secret**: for an environment variable it says whether it is set, never its value (a proxy URL can carry a password).
- **The setup checklist** starts with "This machine has what Atticus needs" (done when nothing fails). **Local API:** `GET /api/doctor` (cached for five minutes; `?fresh=1` checks again); the app shows it on Settings as "This machine".

## Consequences

The first thing a platform lead runs after installing tells them what to fix and how. Checks that need the network (can the Git host or a wiki be reached) stay with the adapters, which fall back to manual steps when they can't connect.
