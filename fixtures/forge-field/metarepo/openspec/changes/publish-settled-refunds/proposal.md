# Proposal

## Why

A refund settles and no other service hears of it.

## What Changes

- forge-svc-01 publishes each settled refund to forge.items.settled.
- forge-audit handles the refund kind on the topic it reads.

## Capabilities

### New Capabilities

- `settled-refunds`

## Impact

forge-svc-01 gains a publish. forge-svc-03 receives one more kind and ignores it. forge-audit is in the manifest and not read, so the map can't check its use.
