import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Api, parseRecord, recordPath, serializeRecord, type CatalogRecord } from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiOnboardingRoutes } from "../src/ui-api-onboarding.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

let srv: RunningServer;
let bare: RunningServer;
let broken: RunningServer;
let root: string;
const written: CatalogRecord[] = [];

const start = (dir: string) =>
  startServer({ root: dir, port: 0, extend: (r, ctx) => uiOnboardingRoutes(r, ctx) });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-onboarding-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  for (const r of parse(readFileSync(join(FIXTURES, "forge/expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) continue;
    written.push(p.record);
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  // One repo cloned (a .git folder is what counts), one with scan settings.
  await mkdir(join(root, "workspace/forge-ledger/.git"), { recursive: true });
  await mkdir(join(root, "org-pack/scan"), { recursive: true });
  await writeFile(
    join(root, "org-pack/scan/forge-ledger.yaml"),
    "schemaVersion: 1\nrepo: forge-ledger\nexclude: []\n",
  );
  srv = await start(root);

  const empty = await mkdtemp(join(tmpdir(), "atticus-ui-onboarding-bare-"));
  await mkdir(join(empty, "org-pack"), { recursive: true });
  bare = await start(empty);

  const bad = await mkdtemp(join(tmpdir(), "atticus-ui-onboarding-bad-"));
  await cp(join(FIXTURES, "forge/metarepo"), bad, { recursive: true });
  await writeFile(join(bad, "org-pack/profiles/forge/repos.manifest.yaml"), "repos: [: nope\n");
  await rm(join(bad, "org-pack/sources.yaml"));
  broken = await start(bad);
});
afterAll(async () => {
  await srv?.close();
  await bare?.close();
  await broken?.close();
});

const get = async (s: RunningServer, path: string) => {
  const r = await fetch(s.url + path, { headers: { "X-Atticus-Token": s.token } });
  return { status: r.status, body: (await r.json()) as unknown };
};

describe("GET /api/onboarding (ADR 0084)", () => {
  it("lists every manifest repo with its manifest file, clone, scan settings and last scan", async () => {
    const r = await get(srv, "/api/onboarding");
    expect(r.status).toBe(200);
    const v = Api.OnboardingView.parse(r.body);
    expect(v.manifests).toEqual([
      {
        platform: "forge",
        path: "org-pack/profiles/forge/repos.manifest.yaml",
        repos: v.repos.length,
      },
    ]);
    const ledger = v.repos.find((x) => x.id === "forge-ledger")!;
    expect(ledger).toMatchObject({
      platform: "forge",
      type: "forge-service",
      owner: "team-ledger",
      manifest: "org-pack/profiles/forge/repos.manifest.yaml",
      cloned: true,
      scanSettings: { path: "org-pack/scan/forge-ledger.yaml", present: true },
    });
    // Counted from the evidence: a record counts once for each repo it cites.
    const cites = written.filter((x) => x.evidence.some((e) => e.repo === "forge-ledger"));
    expect(ledger.lastScan!.records).toBe(cites.length);
    expect(Object.values(ledger.lastScan!.kinds).reduce((a, b) => a + b, 0)).toBe(cites.length);
    const bff = v.repos.find((x) => x.id === "forge-portal-bff")!;
    expect(bff.cloned).toBe(false);
    expect(bff.scanSettings.present).toBe(false);
    expect(v.catalog.records).toBe(written.length);
    expect(v.problems).toEqual([]);
  });

  it("says when no record cites a repo", async () => {
    const v = Api.OnboardingView.parse((await get(srv, "/api/onboarding")).body);
    const cited = new Set(written.flatMap((x) => x.evidence.map((e) => e.repo)));
    const uncited = v.repos.filter((x) => !cited.has(x.id));
    for (const x of uncited) expect(x.lastScan).toBeNull();
  });

  it("shows the knowledge sources from sources.yaml", async () => {
    const v = Api.OnboardingView.parse((await get(srv, "/api/onboarding")).body);
    expect(v.sources).toMatchObject({ path: "org-pack/sources.yaml", present: true });
    expect(v.sources.wikis).toEqual([
      {
        id: "forge-wiki",
        type: "markdown-folder",
        location: "../../inputs/wiki",
        spaces: [],
        owner: "team-platform",
      },
    ]);
  });

  it("is empty, not an error, before anything is set up", async () => {
    const v = Api.OnboardingView.parse((await get(bare, "/api/onboarding")).body);
    expect(v.manifests).toEqual([]);
    expect(v.repos).toEqual([]);
    expect(v.sources.present).toBe(false);
    expect(v.catalog.records).toBe(0);
  });

  it("names a manifest it can't read as a problem instead of failing", async () => {
    const r = await get(broken, "/api/onboarding");
    expect(r.status).toBe(200);
    const v = Api.OnboardingView.parse(r.body);
    expect(v.repos).toEqual([]);
    expect(v.problems.map((p) => p.file)).toContain("org-pack/profiles/forge/repos.manifest.yaml");
    expect(v.sources.present).toBe(false);
  });
});
