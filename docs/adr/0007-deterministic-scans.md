# 0007. Deterministic scans

- Status: accepted
- Date: 2026-10-18

## Decision

Extractors, dialects and ingestors of structured files read files only: no network, no AI. AI is used to write dialect rules once, to resolve leftovers one file at a time (tagged inferred), and to read free text and images. Results are cached by repo commit and extractor version.

## Consequences

Same input, same catalog; scans are cheap enough to run on every change, and every fact is auditable.
