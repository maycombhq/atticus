# 0004. Provenance and confidence

- Status: accepted
- Date: 2026-10-18

## Decision

- Every record carries at least one evidence entry (source, repo, path, line, commit, scan time, extractor and dialect versions, side). Curated decisions are their own provenance.
- Confidence: verified (read from code, config or a published spec; an interface needs both ends seen), inferred (one end, a diagram, a document or a rule), asserted (stated or confirmed by a person, with manual evidence naming who). Documents are never asserted.
