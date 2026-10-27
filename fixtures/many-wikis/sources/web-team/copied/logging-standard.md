---
title: Logging Standard
owner: Web team
updated: 2026-09-01
space: copied from the EA space
---
# Logging Standard

## Structured log lines

- A service writes every log line as one JSON object with the fields timestamp, level, service, traceId and message.
- A log line never carries a card number, a password or a token.
