import { describe, expect, it } from "vitest";
import type { CatalogRecord, ScanSettings } from "@maycombhq/core";
import { memoryRepo } from "@maycombhq/sdk";
import { applyClients, checkScanSettings, joinBase } from "../src/index.js";

/** Client base URLs in scan settings (ADR 0076): checked against the code, then applied. */
const SHA = "a".repeat(40);
const repo = memoryRepo("forge-notes-web", SHA, {
  "src/environments/environment.ts":
    'export const environment = {\n  NOTES_API_URL: "https://notes.forge.internal/notes-api/",\n};\n',
  "src/app/api.interceptor.ts":
    "export const api = (req, next) => next(req.clone({ url: `https://tags.forge.internal/api${req.url}` }));\n",
  "src/app/note.service.ts":
    'entityUrl = environment.NOTES_API_URL + "notes";\nget() { return this.http.get(this.entityUrl); }\n',
  "src/app/tags.service.ts": 'all() { return this.http.get("/tags"); }\n',
  "src/legacy/old.js": 'fetch("/legacy/x");\n',
});

const settings = (clients: object[]): ScanSettings =>
  ({ schemaVersion: 1, repo: "forge-notes-web", exclude: [], prefixes: [], clients }) as never;

const NOTES = {
  paths: ["src/app/note.service.ts"],
  base: "https://notes.forge.internal/notes-api/",
  names: ["environment.NOTES_API_URL"],
  why: "the notes service's URL in the environment file",
  at: "src/environments/environment.ts:2",
  value: "https://notes.forge.internal/notes-api/",
};
const TAGS = {
  paths: ["src/app/**"],
  base: "https://tags.forge.internal/api",
  why: "the interceptor puts the API's URL in front of every request",
  at: "src/app/api.interceptor.ts:1",
  value: "https://tags.forge.internal/api",
  names: [],
};

const call = (raw: string, path: string): CatalogRecord =>
  ({
    schemaVersion: 1,
    kind: "Unresolved",
    id: `notes-web.http-call.${raw.length}`,
    status: "current",
    confidence: "inferred",
    unresolvedKind: "http-call",
    raw,
    owner: "notes-web",
    evidence: [{ source: "code", repo: "forge-notes-web", path, line: 2, commit: SHA }],
  }) as unknown as CatalogRecord;

describe("client base URLs (ADR 0076)", () => {
  it("joins a base and the rest of a URL with one slash", () => {
    expect(joinBase("https://x/api/", "owners")).toBe("https://x/api/owners");
    expect(joinBase("https://x/api", "/articles")).toBe("https://x/api/articles");
    expect(joinBase("https://x/api/", "/articles")).toBe("https://x/api/articles");
    expect(joinBase("/petclinic/api", "?q=1")).toBe("/petclinic/api?q=1");
    expect(joinBase("/", "/notes")).toBe("/notes");
    expect(joinBase("https://x/api/", "")).toBe("https://x/api/");
  });

  it("checks each entry against the code: the cited line, the base, the names", async () => {
    const s = await checkScanSettings(
      settings([
        NOTES,
        TAGS,
        { ...NOTES, at: "src/environments/environment.ts:1" },
        { ...NOTES, base: "https://other.forge.internal/" },
        { ...NOTES, names: ["environment.NOTES_URL"] },
        { ...NOTES, at: "src/environments/prod.ts:2" },
      ]),
      repo,
    );
    expect(s.clients.map((c) => c.base)).toEqual([NOTES.base, TAGS.base]);
    expect(s.problems).toEqual([
      "clients.2: src/environments/environment.ts:1 doesn't say https://notes.forge.internal/notes-api/, so the base isn't applied",
      "clients.3: the base https://other.forge.internal/ isn't the value https://notes.forge.internal/notes-api/ written at src/environments/environment.ts:2, so it isn't applied",
      "clients.4: environment.NOTES_URL isn't in any file under src/app/note.service.ts, so the base isn't applied",
      "clients.5: src/environments/prod.ts:2 isn't in the repo, so the base isn't applied",
    ]);
  });

  it("puts the base in front of named and host-less calls in the files it covers, citing it", async () => {
    const s = await checkScanSettings(settings([NOTES, TAGS]), repo);
    const out = applyClients(
      [
        call("GET ${environment.NOTES_API_URL}notes/{id}", "src/app/note.service.ts"),
        call("GET /tags", "src/app/tags.service.ts"),
        call("GET /legacy/x", "src/legacy/old.js"),
        call("GET https://elsewhere.example/x", "src/app/tags.service.ts"),
        call("GET ${environment.OTHER}x", "src/app/tags.service.ts"),
      ],
      s.clients,
    ) as unknown as { raw: string; evidence: { path: string; line?: number }[] }[];
    expect(out.map((r) => r.raw)).toEqual([
      "GET https://notes.forge.internal/notes-api/notes/{id}",
      "GET https://tags.forge.internal/api/tags",
      "GET /legacy/x",
      "GET https://elsewhere.example/x",
      "GET ${environment.OTHER}x",
    ]);
    expect(out[0]!.evidence.map((e) => `${e.path}:${e.line}`)).toEqual([
      "src/app/note.service.ts:2",
      "src/environments/environment.ts:2",
    ]);
    expect(out[2]!.evidence).toHaveLength(1);
  });
});
