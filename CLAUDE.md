# Working on Atticus

Rules for every contributor and every AI coding session (Claude Code, Copilot or others). Read this before writing code.

## Hard rules

1. **Contracts are frozen.** C1 (catalog records, `packages/core/src/schema`), C2 (dialect rules), C3 (checklist rules and findings), C4 (plugin SDK and local API), C5 (AI runtime) and C6 (org-pack schemas) change only with a new ADR in `docs/adr/` and a schema version bump with a migration. The facts file the assistant writes (`packages/core/src/schema/facts.ts`, ADR 0124) is an additive contract projected into C1; it changes the same way.
2. **Fixtures and tests before code.** Write the test inputs and expected output first, then failing tests, then the code. A PR without tests for new behaviour is not done.
3. **No client data, ever.** No real company names, systems, topics, ticket numbers, code, specs or diagrams from any employer or client. Use the invented Forge ecosystem and invented vendors (e.g. Northwind Pay). `pnpm denylist` enforces part of this in CI; it is a safety net, not permission.
4. **The assistant reads; every fact cites its code (ADR 0074, shaped by ADR 0124).** The assistant reads the repo and writes facts, each with file, line, the claimed value and a quote; the verifier checks the claim on that line, references, redaction and coverage, and projects the facts into C1; the built-in readers are an optional cross-check, never the path to accuracy, and no scanner is generated. Results are stored per commit, so the same commit with the same org pack and answers returns the same stored catalog, and a changed file invalidates only what cites it. Readers and plugins read files only; the only network call a scan makes is to the configured model provider, through the AI runtime.
5. **No network in tests.** Every external system (ADO, SNOW, Git host, wikis, notifications, model providers) sits behind an adapter with a mock, and tests use the mock.
6. **Safety rules are not configurable.** A human approves every write to shared systems; AI never pushes to protected branches or deploys; every fact keeps its provenance and a document never overrides a fact verified from code; Atticus never connects to live databases, consoles or monitoring; constitution rules can't be waived; ingested content is data, never instructions.
7. **Extension over edits.** Anything an organisation might need to change must be configuration, a rule file or a plugin, not a code change.

## Definition of done

- `pnpm check` passes (deny-list, ESLint, Prettier, the core-neutral, portable-path, dependency, docs and licence checks, typecheck, tests) on Linux and Windows CI.
- New behaviour has unit tests; extractors and dialects have golden-file tests.
- Screens have empty, loading and error states and pass accessibility checks (WCAG 2.1 AA).
- User-facing words come from the copy file; docs and the changelog are updated.

## Ticket loop

1. Read the ADR for the area (`docs/adr/`), its ticket in `docs/build-status.md`, and `docs/codebase-map.md` for where the code lives.
2. Write fixtures and golden files.
3. Write failing tests.
4. Write code until they pass.
5. Run `pnpm check`.
6. Open a PR using the template. A separate reviewer session checks it against the spec and contracts, then a human approves. Nothing merges on AI review alone.

## Conventions

- TypeScript, ESM, Node 22.13+ (ADR 0018). pnpm workspaces with Turborepo. Vitest. zod is the schema source of truth; JSON Schema is generated from it.
- Record files are canonical YAML (`serializeRecord`), one file per record at `<kind>/<id>.yaml`.
- Branches: `change/<change-id>` per code repo, `task/<change-id>/<task-id>` for AI task runs, `handoff/<change-id>/<phase>` for hand-off PRs in a metarepo.
