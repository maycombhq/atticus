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
