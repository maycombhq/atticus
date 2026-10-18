# 0003. Catalog files

- Status: accepted
- Date: 2026-10-18

## Decision

- Files in Git are the source of truth; the SQLite index is a disposable view.
- `catalog/generated/` is written only by scans and committed only through catalog PRs. `catalog/curated/` holds human decisions and is never written by scans.
- One file per record at `<kind>/<id>.yaml`. Ids are lowercase slugs safe as file names on every OS.
- Files are canonical YAML: fixed leading keys (schemaVersion, kind, id, status, confidence), the rest alphabetical, no folding, LF, one trailing newline. Re-serializing is byte-identical.
- Interface ids are a hash of from, to, method and normalised path, so the same edge found by several extractors merges.

## Consequences

Parallel scans and PRs rarely touch the same file; diffs show only real changes.
