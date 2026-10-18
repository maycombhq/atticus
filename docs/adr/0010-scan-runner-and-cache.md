# 0010. Scan runner and commit-keyed cache

- Status: accepted
- Date: 2026-10-18

## Decision

`scanRepo` in `@maycombhq/sdk` runs every extractor over one repo at one commit.

- **Repo access.** `fsRepo` gives extractors a read-only view of a base clone: sorted, forward-slash paths; `.git`, dependency and build folders skipped; symbolic links never followed; no path may leave the repo; a size limit per file; byte-order marks stripped.
- **Stamping.** The runner fills in the repo, commit, scan time and `id@version` on every piece of evidence read from the repo, so extractors don't repeat it and can't get it wrong.
- **Validation.** Every record is checked against contract C1. Invalid records and duplicates are reported, never returned.
- **Isolation.** An extractor that throws is reported as failed and its partial output is dropped; the others still run. An extractor whose claimed files are absent is skipped.
- **Determinism.** Extractors run in id order and records are sorted by kind, id and extractor, so the same input gives byte-identical output.
- **Cache.** A result is keyed by repo, full commit SHA, extractor id and version, the dialects in force (order ignored) and a hash of any configuration the extractor reads. Same key, same records: an unchanged repo is never scanned twice, and bumping an extractor's version or editing a dialect rule file invalidates exactly what it affects. Dirty checkouts are never cached. Cached records keep the time they were really scanned.
- **On disk.** `fsScanCache` stores one JSON file per key under `.index/scan-cache/<repo>/<commit>/` (git-ignored), written atomically and checksummed. A corrupt or outdated file is a miss, so the worst case is a rescan. `prune` drops commits no longer needed.

## Consequences

A full rescan of a large estate costs only the repos that changed since the last scan. Extractor authors write parsing code only; provenance, validation, caching and ordering are the runner's job.
