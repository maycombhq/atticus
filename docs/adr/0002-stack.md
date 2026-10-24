# 0002. Stack

- Status: accepted
- Date: 2026-10-18

## Decision

- TypeScript on Node 22.12+ (ESM), pnpm workspaces with Turborepo, Vitest, ESLint and Prettier.
- zod is the schema source of truth; JSON Schema is generated from it.
- `yaml` for files, written in canonical form.
- Local index: `node:sqlite`, with better-sqlite3 as fallback; always rebuilt from files.
- Code parsing: web-tree-sitter (WASM); fast-xml-parser for XML.
- Git through the git CLI; worktrees for change workspaces.
- Local server: Fastify on 127.0.0.1 with a session token; UI: React with Vite.
- Headless rendering: playwright-core with a provided Chromium; diagrams via the unmodified draw.io viewer and Mermaid.

## Consequences

No native build tools are needed for the default install, which matters on locked-down laptops.

## Amended by ADR 0116 (2026-10-23)

A local embedding model runs with onnxruntime-node (prebuilt N-API, no build tools; the CPU build only, without DirectML) and falls back to onnxruntime-web's WASM build; neither is in the lockfile: the offline bundle carries them with the model. sqlite-vec and transformers.js are not used (ADR 0116 says why).
