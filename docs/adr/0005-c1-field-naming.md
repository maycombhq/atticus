# 0005. C1 field naming and generic values

- Status: accepted
- Date: 2026-10-18

## Context

The plan's C1 table used `kind` for some records' sub-types and a few organisation-specific values.

## Decision

- Every record's top-level `kind` is its record type. Sub-types use specific names: endpointType, tableKind, constraintKind, settingKind, assetKind, subjectKind, obligationKind, partyKind, artifactType, unresolvedKind, storeType, docType.
- Values are generic: Interface `via` is gateway, direct, event-bus, pubsub, sftp, mq or other; Component `runtime` is free text (kubernetes, openshift, cloud-run, vm, ...). Organisation-specific names belong in dialects and the org pack.
- Initiative gains a `title`. Interface carries `method` and `normalizedPath` so its id can be checked.
- Records are strict: unknown fields are rejected so typos fail loudly.
