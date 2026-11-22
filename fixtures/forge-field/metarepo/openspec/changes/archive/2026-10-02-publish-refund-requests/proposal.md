# Publish refund requests

## Why

The audit service needs to know when a refund is requested, without the refund service calling it. The refund service publishes a refund requested event to a topic and the audit service listens to it.

## What changes

- The refund service publishes an event for each refund requested.
- The audit service listens to the topic and stores each event.
