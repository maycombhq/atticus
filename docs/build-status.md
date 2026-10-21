# Build status

Where the build is, so any session (cloud or local, Claude Code or Copilot) can pick up the next ticket. Update this file in the same commit as each ticket.

## Done (M0)

| Ticket | What                                                                                                                                                                                                                                                       | Where                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1–3    | Monorepo, CI on Linux and Windows, ADRs 0001–0007, deny-list, contract C1 (29 record kinds), canonical YAML, JSON Schema export, `atticus catalog validate`                                                                                                | `packages/core`, `packages/cli`, `docs/adr`                                   |
| 3      | Plugin SDK basics (C4): `defineExtractor`, `runExtractor`, `memoryRepo`                                                                                                                                                                                    | `packages/sdk`                                                                |
| 4      | Forge fixture ecosystem: seven repos, diagram, wiki pages, tickets, hand-written expected catalog, 13 seeded discrepancies                                                                                                                                 | `fixtures/forge`, `packages/fixtures`                                         |
| 5      | OpenSpec adapter (pinned CLI, contract tests, org-flow schema); `repos.manifest.yaml` and change `repos.yaml`; workspace manager (base clones, change worktrees, VS Code and IntelliJ workspaces, prune); `atticus openspec`, `atticus workspace`          | `packages/openspec-adapter`, `packages/workspace`, ADRs 0008–0009             |
| 6      | Scan runner: `fsRepo` over base clones, evidence stamping, C1 validation, extractor isolation, deterministic order; commit-keyed scan cache in memory or on disk; `checkoutState`                                                                          | `packages/sdk`, `packages/workspace`, ADR 0010                                |
| 7      | Contracts C2 (dialect rule file) and C3 (checklist packs and findings) with one shared template grammar; JSON Schema; the Forge dialect and an architecture checklist as samples in the fixture org pack                                                   | `packages/core`, `fixtures/forge/metarepo/org-pack`, ADR 0011                 |
| 8a     | Contract C6: every org-pack file as a schema, built-in defaults (13 roles, 6 change types, a gate per phase), `loadOrgPack` with cross-file checks, `atticus orgpack validate`; a full Forge org pack in the fixture                                       | `packages/core`, `packages/cli`, `fixtures/forge/metarepo/org-pack`, ADR 0012 |
| 8b     | Adapters (C4): work tracker, service desk, Git host, wiki, design tool, notifications; approval required on every write; merge gated by reviews and checks; mocks with journals, injected failures and fixture loaders; `createAdapters` from runtime.yaml | `packages/adapters`, ADR 0013                                                 |
| 8c     | Contract C5: agent definitions, context packs (data wrapping, classification, budget, manifest), the hand-off runtime with `atticus handoff done`, model runtime, mock and recorded-replay runtimes, run summaries and retention                           | `packages/ai`, `packages/core`, ADR 0014                                      |
| 9      | The local API as an OpenAPI 3.1 document generated from zod, validated, committed at `docs/api/openapi.json`; the synthetic estate generator (300 repos by default) with a scale test proving exact counts and cached rescans                              | `packages/core`, `packages/synth`, ADR 0015                                   |

## Done (M1, exit met: see `docs/m1-exit.md`)

| Ticket | What                                                                                                                                                                                                                                                                                                                                       | Where                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 10–11  | Built-in extractors (component, OpenAPI, Apigee, Spring, frontend, topics, SQL migrations, infrastructure) with Java, YAML, XML and SQL readers; loose ends as Unresolved records; the C2 dialect rule engine and dialect test runner; the Forge dialect passes its tests                                                                  | `packages/extractors`, ADR 0016                                                       |
| 12     | Merge and identity (canonical endpoint ids, interface ids, loose ends resolved through the gateway, by host and within a system, events, table access, inferred patterns, systems from the profile); the estate scan with dialect self-tests and cache; `atticus scan` and `atticus catalog diff`; catalog files written in canonical form | `packages/core`, `packages/scanner`, `packages/cli`, ADR 0017                         |
| 13     | Local SQLite index (rebuilt from files when they change), reference fields read from C1, the catalog query language, graph and impact with gaps; `atticus query`, `atticus impact`, `atticus index rebuild`; minimum Node 22.13                                                                                                            | `packages/index`, `packages/core`, `packages/cli`, ADR 0018, `docs/query-language.md` |
| 14     | draw.io reader and ingestor (compressed pages, HTML labels, legends), aliases (curated decisions, ids, profile), reconcile with ten item types and suggested curated decisions; `atticus reconcile`, `atticus alias`; scan-then-reconcile finds d01–d06                                                                                    | `packages/reconcile`, `packages/cli`, ADR 0019                                        |
| 15     | M1 exit check on 300 synthetic repos: full pipeline, catalog files and index; one-repo change rescanned and reindexed in about 5 s; index 5 MB. Merge splits a store claimed by two owners; the synthetic estate's Spring repos call through the gateway with Feign                                                                        | `packages/scanner`, `packages/synth`, `packages/core`, ADR 0020, `docs/m1-exit.md`    |

## Done (M2, exit met: see `docs/m2-exit.md`)

| Track | What                                                                                                                                                                                                                                                               | Where                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| T5    | Knowledge sources (read-only wiki adapters), wiki facts against code (document conflicts, document-only facts), pattern scan, knowledge gaps with owner questions, coverage, freshness; `atticus sources`, `patterns scan`, `coverage`, `questions`. Finds d09–d12 | `packages/knowledge`, ADR 0021                                                  |
| T3    | Ingestors: Lucid CSV, Visio .vsdx, Mermaid diagrams; Markdown, HTML, text, .docx, .pptx, .xlsx, PDF documents; images and Figma as records; safe in-house ZIP reader; `atticus reconcile` reads every diagram format                                               | `packages/ingestors`, ADR 0022                                                  |
| T1    | Backend extractors for .NET, Python, Go and Node (tolerant TypeScript lexer, no native modules): served routes, outgoing calls, events, database connections                                                                                                       | `packages/extractors/src/backends`, ADR 0023                                    |
| T2a   | Platform extractors: OpenShift, GCP, pipelines, access, batch schedules                                                                                                                                                                                            | `packages/extractors/src/platform`, ADR 0024                                    |
| T2b   | ORM, observability-as-code, AsyncAPI and mainframe extractors; shipped dialects jaxrs, micronaut, quarkus-reactive-messaging (loaded as defaults by the scanner)                                                                                                   | `packages/extractors/src/data`, `packages/extractors/dialects`, ADR 0025        |
| T4    | Intake of `inputs/` (classification, dedupe, versions, partner specs, payloads) inside every scan; triage with curated-decision options; `applyCurated` on every scan; `atticus intake`, `atticus triage`. Forge now matches `expected/scan.yaml` field for field  | `packages/intake`, `packages/core/src/curated.ts`, `packages/scanner`, ADR 0026 |
| T6    | Stub servers from specs or the catalog; Mermaid and draw.io views and a shape library; reconcile accepts drawn data access; `atticus stub`, `atticus diagram`                                                                                                      | `packages/stubs`, `packages/diagrams`, ADR 0027                                 |
| T7    | Dialect build kit, `atticus dialect new/test/run/kit`, and the M2 exit grader with the Forge Messaging eval fixture                                                                                                                                                | `packages/assistant-kit`, `fixtures/forge-dialect-eval`, ADR 0028               |

## Done (M3, exit met: see `docs/m3-exit.md`; live runs 5 of 5, evidence in `docs/evidence/m3-live/`)

| Track | What                                                                                                                                                                                                                                                                                                                                                                                                                               | Where                                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A     | Change lifecycle: `change.yaml` contract, change types and templates, hand-off PRs through the Git host adapter with auto-merge, separation of duties, privacy impact, risk scoring, test strategy by type, conflict detection; `atticus change new/status/handoff/sync/return/archive/list/conflicts`                                                                                                                             | `packages/changes`, `packages/core/src/schema/change.ts`, ADR 0029                                  |
| B     | The critic: built-in constitution, rule layering (constitution, org, team; never loosened), 21 deterministic checks with needs-driven knowledge gaps, AI lenses bounded by evidence, rounds and gates, actions, override stats; the M3 exit fixture `fixtures/forge-change/` (14 blocking issues and 13 gaps caught); `atticus critic`, `findings`, `finding`                                                                      | `packages/naysayer`, `fixtures/forge-change`, ADR 0034                                              |
| F1    | Features found in code: catalog schema version 2 with the `Capability` kind and `atticus catalog migrate`, detection in every scan, AI name proposals, people name/tag/merge/split/link through curated decisions, work-item link suggestions (adapter or exports), six feature knowledge checks and feature coverage; `atticus feature ...`                                                                                       | `packages/features`, `packages/core`, `packages/knowledge`, `packages/intake`, ADR 0031             |
| D     | Run with AI (plan, draft, PR; hand-off, model, headless Claude Code; build-fix rounds), the runtime factory, the Spec Kit layer (hand-down, `speckit` extractor, hand-up, three-way drift on built-in gates), assistant files for Copilot and Claude Code from one source, C6 `buildEngine` and `manual` adapters; `atticus task run`, `spec hand-down/hand-up`, `drift`, `assistant-files`, `feature suggest-names`               | `packages/taskrun`, `packages/speckit`, `packages/assistant-files`, `packages/ai`, ADR 0036         |
| C     | Planning (stories, tasks, service-desk drafts) and the story bar (met on forge-change), work-item sync, manual adapters for every external system with automatic fallback (Plan to Release runs all-manual), templates drafted from wikis, uploads and past tickets, procedures and the executor protocol (http, command, MCP) with a reference executor; `atticus plan`, `ado sync`, `templates draft`, `todo`, `executors check` | `packages/planner`, `packages/executors`, `packages/adapters/src/manual`, ADR 0037                  |
| E     | `atticus init`, repo discovery, adopt in place (writes only `.atticus/`, byte-identical unadopt, every command resolves through the layout), absorb (prompts, agents, checklists, Spec Kit, OpenSpec, schemas → org-pack proposals; 100% translated on fixtures), federation of another Atticus metarepo in the scan, zero-install commands in adopted repos                                                                       | `packages/adopt`, `packages/core/src/metarepo.ts`, ADR 0038                                         |
| F2    | Test generation (Gherkin, JSON, JUnit 5 + RestAssured, Vitest/Jest) from stories, traceability on a built-in `trace` gate, the pipeline drift check with CI templates, the archive gate before `change archive`, and the business glossary built in every scan; `atticus tests generate`, `trace`, `ci drift/snippet/archive-gate`, `glossary`                                                                                     | `packages/testgen`, `packages/ci`, `packages/glossary`, ADR 0039                                    |
| G     | Initiatives with guided journeys, critical path and system cards; learning lessons per role with a practice sandbox and `explain`; the AI eval harness (mock, replay, live with the 4-of-5 bar); defences for ingested content in every context pack with a red-team suite; `atticus initiative`, `learn`, `sandbox`, `explain`, `eval`, `defences scan`                                                                           | `packages/initiatives`, `packages/learn`, `packages/evals`, `packages/ai/src/defences.ts`, ADR 0042 |

## Done (M4, exit met: see `docs/m4-exit.md`; person items listed there)

| Area           | What                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server and API | The local server (127.0.0.1, session token) with read and write calls that run the CLI's own commands; every call in `docs/api/openapi.json` (ADRs 0015, 0043)                                               |
| Screens        | All 27 screens of the design canvas in the HUD look on real data, each with empty, loading and error states; a refusal that names a first step shows as an empty state                                       |
| Roles          | Role views and homes, "Waiting on you", approvals from ownership only (ADR 0044); first-run tours and Help; guided setup and the catalog baseline (ADR 0047)                                                 |
| Knowing        | Ctrl+K palette, Ask in plain words, system guides, the read-only catalog site, incident mode in the Impact explorer                                                                                          |
| Delivering     | Release views (deployment plan, forecast, evidence pack, notes, outcomes, security review; ADR 0045); views across all changes, approvals waiting, the personal digest and the field-mapping grid (ADR 0048) |
| AI switch      | `runtime.yaml ai: on, text-only or off`; every gate works without AI (ADR 0046)                                                                                                                              |
| Exit           | `packages/journeys`: the 13 role journeys, axe on every screen, empty and unreachable states (98 tests); `packages/m4-exit`: onboarding, knowledge-source and drafted-org-pack bars on a fresh sandbox       |

## Done (M5, exit met: see `docs/m5-exit.md`; version 1.0.0-rc.1)

| Area     | What                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| Install  | The offline bundle with install scripts, checksums, SBOM and licences (ADR 0052); `atticus doctor` (ADR 0049)      |
| Support  | The redacted local log, crash messages, whole-file writes, one scan at a time, `atticus support bundle` (ADR 0050) |
| Upgrade  | `atticus upgrade` and the metarepo stamp (ADR 0051)                                                                |
| Security | The threat model; hardening headers                                                                                |
| Quality  | Performance budgets (`packages/m5-exit`); dependency, licence and docs checks in `pnpm lint`                       |
| Docs     | Install, admin, role and troubleshooting guides; the command reference; README and changelog                       |

## Next

1. **M0 sign-off** (Tom George): the expected catalog in `fixtures/forge/expected/` and ADRs 0001–0042; and the in-bank spikes (installs per role, Copilot features in VS Code and IntelliJ).
2. **For a person (M3):** grade the namers' and drafters' output in `docs/evidence/m3-live/for-a-person.md`, and do the real assistant smoke runs listed in `docs/m3-exit.md` (Claude Code, VS Code Copilot, IntelliJ Copilot).
3. **For a person (M4):** time the onboarding bars with someone new on a sandbox, accept a drafted org pack, and a screen-reader pass (`docs/m4-exit.md`, "For a person").
4. **For a person (M5):** run the full CI matrix (Windows, Node 24 and the offline bundle on both systems), install the bundle on the target laptop and run `atticus doctor`, hand the threat model, SBOM and licences to the security review, then decide 1.0 (`docs/m5-exit.md`).
5. **Review ADRs 0053–0072** (Tom George).
6. **For a person (ADR 0065):** call each model provider once against a real endpoint (Anthropic, Azure OpenAI or the internal gateway, Bedrock) from a laptop behind the corporate proxy, and record the result.

## To do (consolidated 2026-10-20)

Every open item, in the order to take them. Check work by running the real flow on a real repo (scan → map → `change new` → `change draft` → `plan stories --draft` → `scan review`), not only the tests. Tick an item off here in the commit that does it.

### A. Fix before pushing (main has unpushed local commits)

- [ ] **A1. CLI test hang under full load.** `packages/cli/test/learn-cli.test.ts` "defences scan" hung for 89 minutes in a full parallel `pnpm test`; two sandbox tests in the same file exited 1. It passes alone. Reproduce under load and fix the cause.
- [ ] **A2. Performance budgets (m5-exit).** Under full load `/api/setup` took 6.06 s (budget 6 s) and CLI start 3.1 s (budget 2 s). Measure on a quiet machine; check whether the tree-sitter baseline-only flag (ADR 0067) costs start time.
- [ ] **A3. A pipeline record changes on every rescan.** `QualityAsset/<repo>.pipeline.ci` reports `(details)` changed on each scan with identical files (seen on a real repo). Find the unstable field (likely from the pipeline-model pass, ADR 0062) and make it deterministic.
- [ ] **A4. Full `pnpm test`** on the 7 GB machine once A1–A3 are fixed; confirm the worker crashes and 5 s timeouts are gone. Regenerate the spec, API and command docs.
- [ ] **A5. Push** the local commits to main.

### B. The core loop: scan → change → stories (what the product is for)

- [ ] **B1. Cut the app down to the core flow.** Open on three things: the map, knowledge gaps, and new change → draft → stories. Hide the other screens behind All screens (or remove them); same short path on the command line.
- [ ] **B2. Walk the knowledge side end to end** on a real repo: intake a real document or diagram, and judge what "knowledge vs code" gives. Expect holes like the change flow had.
- [ ] **B3. Feature grouping.** 134 of 150 features found on the real repo are one endpoint each (RPC-style API). Run and improve `atticus feature suggest-names` and merging so related endpoints group (all `/api/narrate/*`, `/api/factsheet/*`).
- [ ] **B4. Planner.** Stories that do the same work get the same task (now told apart by requirement name): merge them into one task. Every story asks only for the change type's default tests.
- [ ] **B5. `change draft`.** The map is chosen by words, not meaning: a brief worded unlike the code finds less. The drafter doesn't write or check `data.md` or `design.md`.
- [ ] **B6. `atticus init` creates the git repository** (and says to set the git user if none is set). A metarepo whose approvals are pull requests must be one; `init` left a real metarepo without one.

### H. Better with every correction (the model authors, with more data than OpenSpec gives it)

Facts stay deterministic: from code, or from a decision a person recorded. The model writes drafts, verdicts and rules; corrections are kept as files in the metarepo, reviewed through PRs, so they work with any model the bank approves.

- [ ] **H1. Capture draft against merged.** When a change's hand-off PR merges, keep what Atticus drafted (proposal, specs, interfaces, stories) beside what was accepted.
- [ ] **H2. Past corrections in future drafts.** `change draft` and `plan stories` get the closest past drafted/accepted pairs as examples ("last time a draft said X, the team changed it to Y").
- [ ] **H3. Measure it.** For every merged change, how much people changed the draft; report whether that falls over time, so "more accurate with every correction" is a number, not a claim.
- [ ] **H4. Repeated corrections become proposed critic rules,** so the check catches them before a person has to.
- [ ] **H5. Atticus inside the assistant.** Expose the map, `change draft`'s context, the critic and the domain profile to Copilot and Claude Code (skills or an MCP server), so developers work in their editor the way OpenSpec runs, with Atticus as the data and the checks.

### C. Scan review follow-ups (ADR 0072)

- [ ] **C1. Remember verdicts.** Ignored gaps are listed again on the next review; record verdicts as decisions a person accepted.
- [ ] **C2. A `vendor` verdict becomes a vendor record** (today: `atticus alias` by hand).
- [ ] **C3. Reader fixes the first review found:** a helper that builds its path with a local function (`studyBase(token)` returning a template); a query string held in a variable (`/api/life-events${q}`); a literal matched to a path parameter (`POST /api/dashas/vimshottari` ↔ `POST /api/dashas/{system}`).
- [ ] **C4. Side-by-side cross-check:** the assistant reads a repo whole (as a call-chain mapper skill does) and Atticus compares its list with the catalog; each difference becomes a review gap.
- [ ] **C5. Point to `scan review` from every scan** that leaves gaps, as it does for onboarding.

### D. Readers a bank estate needs (from another team's backend and frontend heuristics)

- [ ] **D1. WCF and legacy .NET:** `.svc` and `.asmx`, `[ServiceContract]`/`[OperationContract]`, `[WebService]`/`[WebMethod]`, Web.config `system.serviceModel` endpoints, WSDL-generated client proxies.
- [ ] **D2. Typed configuration:** `IOptions<T>` classes mapped to their appsettings keys.
- [ ] **D3. Auth:** `[Authorize]` and auth middleware; a non-public endpoint without it is a finding.
- [ ] **D4. Request and response types per endpoint** (DTOs, `Task<T>`, `Promise<T>`, `@RequestBody`). Then: each component's current contract exported as OpenAPI (TypeSpec as an org-pack option if the bank adopts it), and a breaking-change check in the critic against the current contract and the callers the catalog knows.
- [ ] **D5. ASP.NET MVC and WebForms:** Razor forms (`Html.BeginForm`), jQuery AJAX, `data-*` bindings.
- [ ] **D6. Endpoint constants with a module prefix** (`<service>/1.0`) used as the cross-repo routing key: verify Atticus joins them; build it if not.
- [ ] **D7. Inside a component:** the controller → service → proxy chain (which action reaches which outgoing call).
- [ ] **D8. Module links:** Gradle `project(":x")` dependencies; `uses` in impact analysis; uses across repos (a library published from one repo).
- [ ] **D9. Domain profile:** classification from column names or annotations; contracts from specs linked to endpoints.
- [ ] **D10. Not read yet (carried over):** Harness triggers, Tekton PipelineRuns and Triggers, Argo CD ApplicationSets, helmfile; Spinnaker, TeamCity, Bamboo, Octopus, CircleCI (onboarding can draft them); EKS, AKS and GKE clusters (C1 has no kind); from Terraform, Lambda triggers, API Gateway integrations, EventBridge rules, module outputs, `count` and `for_each`; manifest readers other than openshift and ingress on built Helm and Kustomize objects; Kustomize remote bases.

### E. Working with an existing AI meta repo

- [ ] **E1. Sample meta repo** with another team's layout (agents, skills, Spec Kit, `repos/`, `domains/`), invented content only; `atticus adopt` it and wire its skills to Atticus: a call-chain skill asks `atticus impact`/`query`, the PO agent uses `change draft`, the naysayer `atticus critic`, `domains/` from `atticus domain profile` with the team's own template.

### F. App and diagrams

- [ ] **F1. One-system context view as text:** the Mermaid and draw.io output still lists calls inside the system as `system --> system`; changing it means reconcile must treat calls inside one drawn box as inside it.
- [ ] **F2. Very large graphs:** the layered canvas wraps columns at 16; check readability at bank scale (hundreds of components).

### G. For a person, and later phases

- [ ] **G1. Review ADRs 0053–0073.**
- [ ] **G2. Call each model provider** once against a real endpoint behind the corporate proxy (ADR 0065). Not built there: streaming, Vertex AI, AWS profiles and SSO, Azure managed identity, a provider plugin loaded from config.
- [ ] **G3. Playwright journeys** on a machine with the browser (not run on this laptop).
- [ ] **G4. `docs/coverage.md`:** what is read and done, partly, or not at all, per area, kept current.
- [ ] **G5. Phase 4, install and security:** the dialect `plugin:` loader and its trust model; Intune/SCCM packaging and signing; dependency scanning; session-token and port hardening.
- [ ] **G6. Phase 5, bank workflow:** the manual ADO path as a first-class flow; ADO over MCP or REST by config; parallel work in the same repos; paging in the screens; the critic saying "could not evaluate".
- [ ] **G7. Phase 6, pilot:** needs the bank's phase 0 (access and installs).

### Done this round (for the record)

Model providers (ADR 0065); onboarding for framework models (0066); the shared parse cache and the worker-crash fix (0067); diagrams draw the chosen view, `Component.uses`, JPQL and upsert fixes (0068); the reader follows a repo's own HTTP helpers, modules take their own type (0069); `change draft` and `plan stories --draft` (0070); `domain profile` and the ASP.NET Core Async fix (0071); `scan review` and three SQL reader fixes it found (0072); discover reads a clone's subfolders as modules; every graph on the layered canvas; the Changes screen fix for AI runs. Roles and in-app approvals removed: the person is the Git user and a gate is approved when its hand-off PR merges; `roles.yaml` deprecated (0073).

## How to work

Follow `CLAUDE.md`: fixtures and tests first, `pnpm check` green, one commit per ticket with the attribution lines, never commit client data.
