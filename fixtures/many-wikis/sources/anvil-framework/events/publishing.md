---
title: Publishing an event with Anvil
owner: Anvil maintainers
updated: 2026-06-30
---
# Publishing an event with Anvil

## Steps

1. Declare the event as a record annotated with @AnvilEvent and the topic.
2. Publish it with the AnvilPublisher after the transaction that saves the change commits.
