# Design

## Context

forge.items.settled exists: forge-svc-02 publishes to it and forge-svc-03 listens.

## Decisions

- forge-svc-01 publishes after its write, with a kind of its own on the event.
- forge-svc-03 changes nothing: it ignores a kind it doesn't know.
- forge-audit handles the new kind; its use of the topic is its team's word until it is read.

## Rollout and rollback

forge-audit is released first, so the kind is handled before it is sent. Rolling back stops the publish; events already sent are ignored by a listener rolled back.

## Risks

Nobody has read forge-audit, so another listener in it would not be seen.
