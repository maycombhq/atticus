---
title: Anvil logging and health guide
space: PLATFORM
tags: [framework, anvil]
owner: Platform Engineering
last-updated: 2023-05-11
---

# Anvil logging and health guide

This page describes how an Anvil 2 service logs and reports its health.

## Logging

- Services write logs to /var/log/anvil/<service>.log, rotated daily.
- Each line starts with the X-Request-Id of the request.

## Request ids

- The first service that receives a request creates an X-Request-Id header.

## Health

- Every service exposes /status, which returns OK when the process is up.
