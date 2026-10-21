---
title: TLS certificates runbook
space: PLATFORM
tags: [platform-runbook, security-standard]
owner: PKI team
last-updated: 2026-06-12
---

# TLS certificates runbook

## Internal certificates

Workloads on the Forge Kubernetes platform get internal certificates from the cert manager, which renews them automatically. Raise a TLS certificate request only for hosts outside the platform.

## Public certificates

Public certificates are valid for one year and are never renewed automatically; the owner team raises a new TLS certificate request 30 days before expiry.

## mTLS with vendors

For a vendor that uses mTLS, the partner gateway presents a client certificate issued by the PKI team for that vendor only.
