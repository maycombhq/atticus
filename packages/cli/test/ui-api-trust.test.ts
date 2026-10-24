import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  Api,
  parseFacts,
  parseRecord,
  projectFacts,
  recordPath,
  serializeRecord,
  type CatalogRecord,
} from "@maycombhq/core";
import { startServer, type RunningServer } from "@maycombhq/server";
import { uiTrustRoutes } from "../src/ui-api-trust.js";

/**
 * GET /api/trust (ADR 0124 addendum, the Map's Trust tab): per repo, from files only, the facts,
 * the verifier's report, the facts' commit against the checkout's HEAD (read from .git, no git
 * run) and whether the catalog's records of the repo come from its facts or the readers.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../fixtures");
const FACTS = join(HERE, "../../verify/test/fixtures/forge-ledger.facts.jsonl");
const SHA = "0123abc" + "0".repeat(33);
const OTHER = "fedcba9" + "1".repeat(33);

let srv: RunningServer;
let bare: RunningServer;
let root: string;

const report = (o: { accepted: number; rejected: number; unknown: string[]; commit?: string }) =>
  [
    `repo: x`,
    ...(o.commit ? [`commit: ${o.commit}`] : []),
    `accepted: ${o.accepted}`,
    `rejected: ${o.rejected}`,
    `redacted: 0`,
    `coverage:`,
    `  ratio: 0.5`,
    `  read: 2`,
    `  unknown: [${o.unknown.join(", ")}]`,
    `  excluded: [generated/client.ts]`,
    `rejections: []`,
    "",
  ].join("\n");

/** A checkout whose HEAD names a branch, kept loose or in packed-refs. */
async function checkout(repo: string, sha: string, packed = false) {
  const git = join(root, "workspace", repo, ".git");
  await mkdir(join(git, "refs", "heads"), { recursive: true });
  await writeFile(join(git, "HEAD"), "ref: refs/heads/main\n");
  if (packed) await writeFile(join(git, "packed-refs"), `# pack-refs\n${sha} refs/heads/main\n`);
  else await writeFile(join(git, "refs", "heads", "main"), `${sha}\n`);
}

async function write(r: CatalogRecord) {
  const f = join(root, "catalog/generated", recordPath(r));
  await mkdir(dirname(f), { recursive: true });
  await writeFile(f, serializeRecord(r));
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ui-trust-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  const text = (await readFile(FACTS, "utf8")).split("\n").filter(Boolean).slice(0, 2).join("\n");
  const facts = parseFacts(text);
  if (!facts.ok) throw new Error("the fixture's facts don't parse");
  await mkdir(join(root, "facts"), { recursive: true });

  // forge-ledger: read, verified, written, at the checkout's commit, two files not read yet.
  await writeFile(join(root, "facts/forge-ledger.jsonl"), text + "\n");
  await writeFile(
    join(root, "facts/forge-ledger.verify.yaml"),
    report({ accepted: 2, rejected: 0, unknown: ["src/a.ts", "src/b.ts"], commit: "0123abc" }),
  );
  await checkout("forge-ledger", SHA);
  for (const r of projectFacts(facts.facts).records) await write(r);

  // forge-portal-bff: verified, but of another commit than the checkout's.
  await writeFile(
    join(root, "facts/forge-portal-bff.jsonl"),
    text.replace(/forge-ledger/g, "forge-portal-bff") + "\n",
  );
  await writeFile(
    join(root, "facts/forge-portal-bff.verify.yaml"),
    report({ accepted: 2, rejected: 0, unknown: [], commit: "0123abc" }),
  );
  await checkout("forge-portal-bff", OTHER);

  // forge-events: the verifier rejected one.
  await writeFile(
    join(root, "facts/forge-events.jsonl"),
    text.replace(/forge-ledger/g, "forge-events") + "\n",
  );
  await writeFile(
    join(root, "facts/forge-events.verify.yaml"),
    report({ accepted: 1, rejected: 1, unknown: [], commit: "0123abc" }),
  );

  // forge-reports-job: verified at the checkout's commit (in packed-refs), not written yet.
  await writeFile(
    join(root, "facts/forge-reports-job.jsonl"),
    text.replace(/forge-ledger/g, "forge-reports-job") + "\n",
  );
  await writeFile(
    join(root, "facts/forge-reports-job.verify.yaml"),
    report({ accepted: 2, rejected: 0, unknown: [], commit: "0123abc" }),
  );
  await checkout("forge-reports-job", SHA, true);

  // forge-infra: a report that isn't YAML.
  await writeFile(
    join(root, "facts/forge-infra.jsonl"),
    text.replace(/forge-ledger/g, "forge-infra") + "\n",
  );
  await writeFile(join(root, "facts/forge-infra.verify.yaml"), "accepted: [: nope\n");

  // forge-gateway: no facts; its records come from the readers.
  for (const r of parse(readFileSync(join(FIXTURES, "forge/expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) continue;
    const repos = new Set(p.record.evidence.map((e) => e.repo));
    if (repos.size === 1 && repos.has("forge-gateway")) await write(p.record);
  }

  // A repo no manifest lists, read all the same.
  await writeFile(
    join(root, "facts/side-tool.jsonl"),
    text.replace(/forge-ledger/g, "side-tool") + "\n",
  );

  srv = await startServer({ root, port: 0, extend: (r, ctx) => uiTrustRoutes(r, ctx) });
  const empty = await mkdtemp(join(tmpdir(), "atticus-ui-trust-bare-"));
  await mkdir(join(empty, "org-pack"), { recursive: true });
  bare = await startServer({ root: empty, port: 0, extend: (r, ctx) => uiTrustRoutes(r, ctx) });
});
afterAll(async () => {
  await srv?.close();
  await bare?.close();
});

const view = async (s: RunningServer) => {
  const r = await fetch(s.url + "/api/trust", { headers: { "X-Atticus-Token": s.token } });
  expect(r.status).toBe(200);
  return Api.TrustView.parse(await r.json());
};

describe("GET /api/trust (ADR 0124)", () => {
  it("says a read, verified and written repo's numbers, and that its catalog is from its facts", async () => {
    const v = await view(srv);
    expect(v.factsDir).toBe("facts");
    const ledger = v.repos.find((r) => r.repo === "forge-ledger")!;
    expect(ledger).toMatchObject({
      facts: {
        path: "facts/forge-ledger.jsonl",
        present: true,
        count: 2,
        unverified: 0,
        commit: "0123abc",
      },
      verify: {
        path: "facts/forge-ledger.verify.yaml",
        report: {
          accepted: 2,
          rejected: 0,
          redacted: 0,
          coverage: { ratio: 0.5, read: 2, unknown: 2, excluded: 1 },
          unknownFiles: ["src/a.ts", "src/b.ts"],
          commit: "0123abc",
        },
      },
      checkout: { path: "workspace/forge-ledger", present: true, commit: SHA },
      sameCommit: true,
      state: "unknown-files",
      next: { command: "atticus map forge-ledger", slash: "/atticus-map forge-ledger" },
    });
    expect(ledger.catalog.from).toBe("facts");
    expect(ledger.catalog.fromFacts).toBeGreaterThan(0);
    expect(ledger.catalog.fromReaders).toBe(0);
  });

  it("says what to run for a repo not read, stale, rejected, unwritten or unreadable", async () => {
    const v = await view(srv);
    const of = (id: string) => v.repos.find((r) => r.repo === id)!;
    expect(of("forge-gateway")).toMatchObject({
      facts: { present: false, count: 0 },
      verify: { report: null },
      checkout: { present: false },
      sameCommit: null,
      catalog: { from: "readers", fromFacts: 0 },
      state: "not-read",
      next: { command: "atticus map forge-gateway", slash: "/atticus-map forge-gateway" },
    });
    expect(of("forge-gateway").catalog.fromReaders).toBeGreaterThan(0);
    expect(of("forge-portal-bff")).toMatchObject({
      sameCommit: false,
      checkout: { commit: OTHER },
      state: "stale",
      next: { command: "atticus map forge-portal-bff", slash: "/atticus-map forge-portal-bff" },
    });
    expect(of("forge-events")).toMatchObject({
      state: "rejected",
      next: { command: "atticus verify forge-events", slash: "/atticus-map forge-events" },
    });
    expect(of("forge-reports-job")).toMatchObject({
      checkout: { commit: SHA },
      sameCommit: true,
      catalog: { from: "none" },
      state: "unwritten",
      next: { command: "atticus verify forge-reports-job --write" },
    });
    expect(of("forge-infra")).toMatchObject({
      verify: { report: null },
      state: "unverified",
      next: { command: "atticus verify forge-infra" },
    });
    expect(v.problems).toEqual([
      expect.objectContaining({ file: "facts/forge-infra.verify.yaml" }),
    ]);
    // Manifest order, then a repo only the facts name.
    expect(v.repos.map((r) => r.repo).at(-1)).toBe("side-tool");
    expect(of("side-tool")).toMatchObject({ checkout: { present: false }, state: "unverified" });
  });

  it("answers with nothing, not an error, on a metarepo with no manifest and no facts", async () => {
    const v = await view(bare);
    expect(v).toEqual({ factsDir: "facts", repos: [], problems: [] });
  });
});
