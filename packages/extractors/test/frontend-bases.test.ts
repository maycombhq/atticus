import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { fsRepo, memoryRepo, scanRepo, type Extractor, type RepoHandle } from "@maycombhq/sdk";
import { nodeExtractor } from "../src/backends/index.js";
import { frontendExtractor } from "../src/index.js";

/**
 * Client calls built from a configured base (ADR 0076): the frontend reader records them with
 * the base's expression, `${environment.NOTES_API_URL}notes`, so a repo's scan settings can put
 * the base in front. Golden lines: one per record.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SHA = "0123456789abcdef0123456789abcdef01234567";

async function golden(repo: RepoHandle, extractors: Extractor[]) {
  const s = await scanRepo({
    repo,
    extractors,
    scannedAt: "2026-10-21T08:00:00Z",
    repoInfo: { component: "notes-web" },
  });
  expect(s.rejected).toEqual([]);
  expect(s.runs.filter((x) => x.status === "failed")).toEqual([]);
  return s.records
    .filter((r): r is CatalogRecord => r.kind === "Unresolved")
    .map((r) => {
      const x = r as unknown as Record<string, unknown>;
      const e = r.evidence[0]!;
      return `${String(x.unresolvedKind)} ${String(x.raw)} @${e.path}:${e.line ?? ""}`;
    })
    .sort();
}

describe("client calls built from a base (ADR 0076)", () => {
  it("records each call with the base's expression, through fields and generics", async () => {
    const repo = fsRepo("forge-notes-web", join(FIXTURES, "frontend", "forge-notes-web"), SHA);
    const N = "src/app/note.service.ts";
    const R = "src/app/report.service.ts";
    const C = "src/features/comments/comments-api.ts";
    expect(await golden(repo, [frontendExtractor])).toEqual(
      [
        `http-call GET \${environment.NOTES_API_URL}notes @${N}:16`,
        `http-call GET \${environment.NOTES_API_URL}notes/{id} @${N}:20`,
        `http-call POST \${environment.NOTES_API_URL}notes @${N}:24`,
        `http-call GET \${environment.NOTES_API_URL}notes/{id}/tags @${N}:28`,
        `http-call GET /tags @${N}:33`,
        `http-call GET /authors/{name}/notes @${N}:38`,
        `http-call GET /listed @${N}:42`,
        `http-call GET \${config.reportsUrl} @${R}:16`,
        `http-call GET \${import.meta.env.VITE_REPORTS_BASE}/exports @${R}:36`,
        // Through an axios instance imported by an alias, with its base; msw handlers left out.
        `http-call GET \${env.API_URL}/notes/{noteId}/comments @${C}:3`,
        `http-call POST \${env.API_URL}/notes/{noteId}/comments @${C}:6`,
        `http-call DELETE \${env.API_URL}/comments/{id} @${C}:8`,
      ].sort(),
    );
  });

  it("leaves a server package's calls to the node reader, so each is recorded once", async () => {
    const repo = memoryRepo("forge-notes-bff", SHA, {
      "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      ".env": "NOTES_URL=https://notes.forge.internal/notes-api\n",
      "src/app.js": [
        'import express from "express";',
        "const app = express();",
        'app.get("/notes", async (_req, res) => {',
        '  const r = await fetch(process.env.NOTES_URL + "/notes");',
        "  res.json(await r.json());",
        "});",
        "",
      ].join("\n"),
    });
    const lines = await golden(repo, [frontendExtractor, nodeExtractor]);
    expect(lines.filter((l) => l.startsWith("http-call"))).toEqual([
      "http-call GET https://notes.forge.internal/notes-api/notes @src/app.js:4",
    ]);
  });
});
