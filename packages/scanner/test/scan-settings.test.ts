import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanEstate } from "../src/index.js";

/**
 * Scan settings per repo (ADR 0075): a context path the readers can't see and a generated
 * folder that isn't the product, in fixtures/scan-settings. With the settings the UI's calls
 * join the service; without them they can't.
 */
const FX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/scan-settings");

async function scan(edit?: (orgPack: string) => Promise<void>) {
  const orgPack = join(await mkdtemp(join(tmpdir(), "atticus-scan-settings-")), "org-pack");
  await cp(join(FX, "metarepo/org-pack"), orgPack, { recursive: true });
  await edit?.(orgPack);
  const s = await scanEstate({
    root: dirname(orgPack),
    orgPack,
    repoDir: (id) => join(FX, "repos", id),
    repoState: async () => ({ commit: "a".repeat(40), dirty: false }),
    cache: null,
    scannedAt: "2026-10-21T12:00:00Z",
  });
  type R = Record<string, unknown> & { kind: string; id: string };
  const recs = s.records as unknown as R[];
  return {
    problems: s.problems,
    endpoints: recs
      .filter((r) => r.kind === "Endpoint")
      .map((r) => `${String(r.method)} ${String(r.pathOrTopic)} ${String(r.normalizedPath)}`)
      .sort(),
    joined: recs
      .filter((r) => r.kind === "Interface")
      .map(
        (r) =>
          `${String(r.from)}->${String(r.to)} ${String(r.method)} ${String(r.normalizedPath)} ${String(r.endpoint ?? "no endpoint")} ${String(r.confidence)}`,
      )
      .sort(),
    loose: recs
      .filter((r) => r.kind === "Unresolved" && r.unresolvedKind === "http-call")
      .map((r) => String(r.raw))
      .sort(),
    /** Every file:line the interfaces cite on the caller's side. */
    callerCites: [
      ...new Set(
        recs
          .filter((r) => r.kind === "Interface")
          .flatMap((r) => r.evidence as { path?: string; line?: number; side?: string }[])
          .filter((e) => e.side === "caller")
          .map((e) => `${e.path}:${e.line}`),
      ),
    ].sort(),
  };
}

/** The UI's calls built from its environment's base, as the reader records them (ADR 0076). */
const BUILT = [
  "GET ${environment.NOTES_API_URL}notes",
  "GET ${environment.NOTES_API_URL}notes/{id}",
  "POST ${environment.NOTES_API_URL}notes",
];

describe("scan settings per repo (ADR 0075)", () => {
  it("without them: endpoints miss the context path, the UI's calls don't join, docs/ is read", async () => {
    const s = await scan((op) => rm(join(op, "scan"), { recursive: true, force: true }));
    expect(s.endpoints).toEqual([
      "GET /notes /notes",
      "GET /notes/{id} /notes/{}",
      "POST /notes /notes",
    ]);
    // The host joins the calls to the service, but no endpoint answers at those paths.
    expect(s.joined.every((j) => j.includes("no endpoint"))).toBe(true);
    expect(s.loose.some((r) => r.includes("docs.forge.internal"))).toBe(true);
    // Calls built from the environment's base keep its name, and reach nothing (ADR 0076).
    expect(s.loose.filter((r) => r.includes("NOTES_API_URL"))).toEqual(BUILT);
  }, 120_000);

  it("with prefixes but no client base: the calls built from the base don't reach the service", async () => {
    const s = await scan((op) => rm(join(op, "scan", "forge-notes-ui.yaml")));
    expect(s.problems).toEqual([]);
    expect(s.joined).toEqual([
      "notes-ui->notes-svc GET /notes-api/notes notes-svc.get-note-613df2 verified",
      "notes-ui->notes-svc POST /notes-api/notes notes-svc.post-note verified",
    ]);
    expect(s.loose).toEqual(BUILT);
  }, 120_000);

  it("with them: every endpoint has the prefix, the UI's calls join, docs/ isn't read", async () => {
    const s = await scan();
    expect(s.problems).toEqual([]);
    expect(s.endpoints).toEqual([
      "GET /notes-api/notes /notes-api/notes",
      "GET /notes-api/notes/{id} /notes-api/notes/{}",
      "POST /notes-api/notes /notes-api/notes",
    ]);
    // The UI's calls built from its environment's base join too (ADR 0076).
    expect(s.joined).toEqual([
      "notes-ui->notes-svc GET /notes-api/notes notes-svc.get-note-613df2 verified",
      "notes-ui->notes-svc GET /notes-api/notes/{} notes-svc.get-note-bf2fbb verified",
      "notes-ui->notes-svc POST /notes-api/notes notes-svc.post-note verified",
    ]);
    // Each built call cites its own line and the line its base is written on.
    expect(s.callerCites).toEqual([
      "src/environment.js:4",
      "src/note.service.ts:16",
      "src/note.service.ts:20",
      "src/note.service.ts:24",
      "src/notes.js:3",
      "src/notes.js:8",
    ]);
    expect(s.loose).toEqual([]);
  }, 120_000);

  it("refuses a client base whose cited line doesn't say it, and leaves those calls loose", async () => {
    const s = await scan(async (op) => {
      const f = join(op, "scan", "forge-notes-ui.yaml");
      await writeFile(
        f,
        (await readFile(f, "utf8")).replace("src/environment.js:4", "src/environment.js:3"),
      );
    });
    expect(s.problems).toContainEqual({
      repo: "forge-notes-ui",
      source: "org-pack/scan/forge-notes-ui.yaml",
      message:
        "clients.0: src/environment.js:3 doesn't say https://notes.forge.internal/notes-api/, so the base isn't applied",
    });
    expect(s.loose).toEqual(BUILT);
  }, 120_000);

  it("refuses an entry whose cited line doesn't say what it claims, and applies the rest", async () => {
    const s = await scan(async (op) => {
      const f = join(op, "scan", "forge-notes.yaml");
      await writeFile(
        f,
        (await readFile(f, "utf8")).replace("value: /notes-api", "value: /notes-v2"),
      );
    });
    expect(s.problems).toContainEqual({
      repo: "forge-notes",
      source: "org-pack/scan/forge-notes.yaml",
      message:
        "prefixes.0: src/main/resources/application.properties:3 doesn't say /notes-v2, so the prefix /notes-api isn't applied",
    });
    expect(s.endpoints[0]).toBe("GET /notes /notes");
    // The exclude still holds: its cited file exists.
    expect(s.loose.some((r) => r.includes("docs.forge.internal"))).toBe(false);
  }, 120_000);
});
