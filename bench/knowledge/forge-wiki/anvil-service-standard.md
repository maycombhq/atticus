---
title: Anvil service standard
space: PLATFORM
tags: [framework, anvil, security-standard]
owner: Platform Engineering
last-updated: 2026-09-02
---

# Anvil service standard

## Scope

This standard applies to every backend service built on Anvil 3, the Forge service framework. It replaces the Anvil 2 logging and health guide (anvil-logging-2023), which no longer applies to any service.

## Logging

- Services log JSON lines to standard output through the Anvil logger; they never write log files.
- Every log line carries service, version, environment and correlationId.
- Fields classified Confidential or Restricted are never written to a log, not even at debug level.
- Debug level is off in production.

## Correlation ids

- The edge (the BFF or the gateway) creates an X-Forge-Correlation-Id header when a request arrives without one.
- Every service passes the header on to every call it makes, and puts it in the forge-correlation-id header of every event it publishes.
- A service never creates a new correlation id for a request that already has one.

## Audit

- Every change to customer data or to money writes an audit record through the Anvil audit client to the audit service.
- An audit record holds the actor, the action, the entity id, the time and a hash of the entity before and after.
- If the audit record cannot be written, the request fails; a service never skips audit to stay available.

## Health endpoints

- Every service exposes /health/live and /health/ready on its management port.
- /health/ready checks the service's own database and broker connections, and nothing else.
- Health endpoints need no authentication and answer within 1 second.
- /health/info returns the build version and commit.

## Configuration and secrets

- Secrets come from the platform vault at start-up and are never committed to a repo or set in a deployment file.
