# 0075. Scan settings per repo, drafted by the AI and checked against the code (C6)

- Status: accepted (pending review by the product owner)
- Date: 2026-10-21
- Builds on: ADR 0074 (the AI reads; every fact cites its code)

## Context

The bench (`bench/README.md`) measured today's readers on 22 public repos: 58% precision, 32% recall. The biggest single cause, in every stack, is path prefixes the readers don't see: a context path in a config file, a global prefix set at start-up, a router mounted under a path, a route convention. The endpoints are found, at the wrong path, so each counts as missed and as wrong. The second cause on some repos is folders that aren't the product (a generated documentation app) being read as code.

Both are facts about one repo that a reader of that repo can see in a file, and that no built-in reader can know in general. ADR 0074 says the AI reads the repo and customises the scanner with the lightest thing that works; nothing in the org pack can hold either fact today.

## Decision

A new org-pack file per repo, `org-pack/scan/<repo>.yaml` (schema `ScanSettings`, schema version 1):

```yaml
schemaVersion: 1
repo: spring-petclinic-rest
exclude:
  - { path: "docs/**", why: "a generated documentation site", at: "docs/index.html:1" }
prefixes:
  - paths: ["src/main/java/**"]
    prefix: /petclinic
    why: server.servlet.context-path
    at: "src/main/resources/application.properties:25"
    value: /petclinic/
```

- `exclude`: folders (globs) the scan doesn't read.
- `prefixes`: a path put in front of every HTTP entry point whose source file matches `paths`, in the order listed (a context path first, then a global prefix).
- Every entry cites `at` (path:line), and a prefix names the `value` as written there. **The citation check** reads that line at the scanned commit and refuses an entry whose line doesn't contain its value; a refused entry is reported and not applied. An exclude's `at` must exist.

`atticus scan survey <repo>` has the person's assistant (any AI runtime: hand-off to Copilot, headless Claude Code in development) read the repo and draft the file; the command checks every entry before writing it and hands back what failed for another attempt (the loop of ADR 0059 and 0070). The file is reviewed like any org-pack change. The scan applies it; the bench measures it.

## Consequences

- C6 gains one optional file kind; nothing existing changes, so no migration. An org pack without `scan/` scans exactly as before.
- The settings are per repo for now. When repo types arrive (plan Phase 2a, I10) the same entries move into a type's scanner configuration and are reused.
- Client base URLs (calls built from a configured base) are the next entries; they need the readers to find the calls first, so they come with the AI verify step.
- Tests use the mock runtime; no test calls a model.
