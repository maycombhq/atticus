---
title: Pub/Sub subscriptions
owner: Cloud Platform team
updated: 2026-07-20
---
# Pub/Sub subscriptions

## Reading from a subscription

1. Ask for the subscription with the Pub/Sub request form, naming the topic and the dead-letter topic.
2. Acknowledge a message only after it is processed.
3. Let a message that fails five times go to the dead-letter topic.
