import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  answerQuestion,
  listQuestions,
  loadOrgPack,
  parseRecord,
  serializeRecord,
  type CatalogRecord,
} from "@maycombhq/core";
import { estateRepos, mergeEstate, readCatalog, writeCatalog } from "@maycombhq/scanner";
import { main } from "../src/main.js";
import { mapRenderCommand } from "../src/map-render-commands.js";
import { verifyCommand } from "../src/verify-commands.js";

/**
 * atticus verify <repo> --write and atticus map render <repo> (ADR 0124, A3b), end to end on an
 * invented two-repo Forge metarepo: the facts become the catalog everything downstream reads,
 * the flows go to specs/<repo>/, a call with no target becomes a question, and the map is
 * rendered under map/<repo>/. The written catalog, flows and map are golden files under
 * packages/verify/test/fixtures/map/ (UPDATE_GOLDEN=1 rewrites them after a review).
 */

const VERIFY = join(__dirname, "..", "..", "verify", "test", "fixtures");
const META = join(VERIFY, "metarepo");
const GOLDEN = join(VERIFY, "map");
const update = process.env.UPDATE_GOLDEN === "1";

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

async function metarepo(facts?: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "atticus-map-"));
  cpSync(join(META, "org-pack"), join(root, "org-pack"), { recursive: true });
  cpSync(join(META, "catalog"), join(root, "catalog"), { recursive: true });
  cpSync(join(VERIFY, "repo"), join(root, "workspace", "forge-ledger"), { recursive: true });
  // The catalog as a reader scan wrote it, before the assistant's facts.
  const op = await loadOrgPack(join(root, "org-pack"));
  const raw = (parse(readFileSync(join(META, "scan-before.yaml"), "utf8")) as object[]).map((x) => {
    const p = parseRecord({ schemaVersion: 2, status: "current", ...x });
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    return p.record;
  });
  await writeCatalog(
    join(root, "catalog", "generated"),
    mergeEstate(op, estateRepos(op), raw).records,
  );
  mkdirSync(join(root, "facts"), { recursive: true });
  writeFileSync(
    join(root, "facts", "forge-ledger.jsonl"),
    facts ?? readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8"),
  );
  return root;
}

const write = (root: string, o = io()) =>
  verifyCommand(
    root,
    "forge-ledger",
    { commit: "0123abc", dir: join(root, "workspace", "forge-ledger"), write: true },
    o.io,
  );

const files = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    ))
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = readFileSync(join(d, e.name), "utf8");
  };
  walk(dir, "");
  return out;
};

const stream = (records: CatalogRecord[]) => records.map(serializeRecord).join("---\n");

function golden(rel: string, text: string) {
  const path = join(GOLDEN, ...rel.split("/"));
  if (update) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  expect(text, rel).toBe(readFileSync(path, "utf8"));
}

describe("atticus verify <repo> --write (ADR 0124, A3b)", () => {
  it("writes the catalog, the flows and the map, as the golden files", async () => {
    const root = await metarepo();
    const o = io();
    expect(await write(root, o)).toBe(0);
    expect(o.err).toEqual([]);
    const text = o.out.join("\n");
    expect(text).toMatch(/17 facts kept, 0 rejected/);
    expect(text).toMatch(/Wrote the catalog/);
    expect(text).toMatch(/map\/forge-ledger\/map\.md/);

    const catalog = await readCatalog(join(root, "catalog", "generated"));
    expect(catalog.problems).toEqual([]);
    golden("forge-ledger.catalog.yaml", stream(catalog.records));
    for (const [rel, t] of Object.entries(files(join(root, "specs", "forge-ledger"))))
      golden(`specs/forge-ledger/${rel}`, t);
    const map = files(join(root, "map", "forge-ledger"));
    expect(Object.keys(map)).toEqual([
      "contracts/ledger-api.openapi.yaml",
      "flows/ledger-api.post-a-ledger-entry.md",
      "map.md",
    ]);
    for (const [rel, t] of Object.entries(map)) golden(`expected/forge-ledger/${rel}`, t);

    // What map render read besides the catalog, for the renderer's own golden test.
    const report = parse(readFileSync(join(root, "facts", "forge-ledger.verify.yaml"), "utf8"));
    const open = (await listQuestions(root, { state: "open", repo: "forge-ledger" })).questions;
    golden(
      "inputs.json",
      JSON.stringify(
        {
          trust: {
            accepted: report.accepted,
            rejected: report.rejected,
            ratio: report.coverage.ratio,
            unknown: report.coverage.unknown.length,
            commit: report.commit,
          },
          questions: open.map((q) => ({ id: q.id, question: q.question, evidence: q.evidence })),
        },
        null,
        2,
      ) + "\n",
    );
  });

  it("leaves every other repo's record files exactly as they were", async () => {
    const root = await metarepo();
    const before = files(join(root, "catalog", "generated"));
    expect(await write(root)).toBe(0);
    const after = files(join(root, "catalog", "generated"));
    const notifyOnly = Object.entries(before).filter(
      ([, t]) => t.includes("repo: forge-notify") && !t.includes("repo: forge-ledger"),
    );
    expect(notifyOnly.length).toBeGreaterThan(3);
    for (const [rel, t] of notifyOnly) expect(after[rel], rel).toBe(t);
  });

  it("writing the same facts again changes no file", async () => {
    const root = await metarepo();
    expect(await write(root)).toBe(0);
    const once = {
      ...files(join(root, "catalog")),
      ...files(join(root, "map")),
      ...files(join(root, "specs")),
    };
    const o = io();
    expect(await write(root, o)).toBe(0);
    const twice = {
      ...files(join(root, "catalog")),
      ...files(join(root, "map")),
      ...files(join(root, "specs")),
    };
    expect(twice).toEqual(once);
    expect(o.out.join("\n")).toMatch(/No catalog changes/);
  });

  it("writes nothing to the catalog while a fact is rejected", async () => {
    const root = await metarepo(
      readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8") +
        readFileSync(join(VERIFY, "redteam.facts.jsonl"), "utf8"),
    );
    const before = files(join(root, "catalog", "generated"));
    const o = io();
    expect(await write(root, o)).toBe(1);
    expect(o.err.join("\n")).toMatch(/Nothing written to the catalog: 11 facts were rejected/);
    expect(files(join(root, "catalog", "generated"))).toEqual(before);
    expect(existsSync(join(root, "map"))).toBe(false);
  });

  it("without --write, only checks: the catalog and the map aren't touched", async () => {
    const root = await metarepo();
    const before = files(join(root, "catalog", "generated"));
    const o = io();
    const code = await verifyCommand(
      root,
      "forge-ledger",
      { commit: "0123abc", dir: join(root, "workspace", "forge-ledger") },
      o.io,
    );
    expect(code).toBe(0);
    expect(files(join(root, "catalog", "generated"))).toEqual(before);
    expect(existsSync(join(root, "map"))).toBe(false);
    expect(o.out.join("\n")).toMatch(/atticus verify forge-ledger --write/);
  });

  it("asks which repo answers on the host a call names, and joins it once answered (ADR 0088)", async () => {
    const root = await metarepo();
    const o = io();
    expect(await write(root, o)).toBe(0);
    const qs = (await listQuestions(root, { state: "open" })).questions;
    const q = qs.find((x) => x.question === "Which repo answers on notify.internal?")!;
    expect(q).toBeDefined();
    expect(q.rerun).toBe("atticus verify forge-ledger --write");
    expect(o.out.join("\n")).toContain(q.id);
    const n = q.options.findIndex((x) => x.label === "forge-notify") + 1;
    await answerQuestion(root, q.id, { option: n, by: "dana.okafor", at: "2026-10-24T10:00:00Z" });
    expect(await write(root)).toBe(0);
    const catalog = (await readCatalog(join(root, "catalog", "generated"))).records;
    expect(
      catalog.some(
        (r) => r.kind === "Interface" && r.from === "ledger-api" && r.to === "notify-api",
      ),
    ).toBe(true);
    const md = readFileSync(join(root, "map", "forge-ledger", "map.md"), "utf8");
    expect(md).toContain("### notify-api");
    expect(md).not.toContain("Not joined yet");
  });

  it("asks which repo or system answers a call with no host, and reads the answer on the next write", async () => {
    const facts = readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8").replace(
      '"host":"notify.internal",',
      "",
    );
    const root = await metarepo(facts);
    expect(await write(root)).toBe(0);
    const qs = (await listQuestions(root, { state: "open", repo: "forge-ledger" })).questions;
    const q = qs.find((x) => x.askedBy.step === "facts-targets")!;
    expect(q.question).toBe("Which repo or system answers POST /notify, which ledger-api calls?");
    expect(q.options.map((x) => x.label)).toEqual(["notify-api", "northwind-fx", "None of these"]);
    const md = readFileSync(join(root, "map", "forge-ledger", "map.md"), "utf8");
    expect(md).toContain(`(../../questions/${q.id}.yaml)`);
    await answerQuestion(root, q.id, { option: 1, by: "dana.okafor", at: "2026-10-24T10:00:00Z" });
    expect(await write(root)).toBe(0);
    const catalog = (await readCatalog(join(root, "catalog", "generated"))).records;
    expect(
      catalog.some(
        (r) => r.kind === "Interface" && r.from === "ledger-api" && r.to === "notify-api",
      ),
    ).toBe(true);
  });
});

describe("the command line", () => {
  it("takes --write as a switch wherever it is, and routes atticus map render", async () => {
    const root = await metarepo();
    const dir = join(root, "workspace", "forge-ledger");
    const o = io();
    const code = await main(
      [
        "verify",
        "--write",
        "forge-ledger",
        "--json",
        "--commit",
        "0123abc",
        "--dir",
        dir,
        "--root",
        root,
      ],
      o.io,
    );
    expect(o.err).toEqual([]);
    expect(code).toBe(0);
    const json = JSON.parse(o.out.join("\n")) as { accepted: number; written: { map: string[] } };
    expect(json.accepted).toBe(17);
    expect(json.written.map).toContain("map/forge-ledger/map.md");
    const r = io();
    expect(await main(["map", "render", "forge-ledger", "--root", root, "--json"], r.io)).toBe(0);
    expect(JSON.parse(r.out.join("\n")).files).toContain("map/forge-ledger/map.md");
  });
});

describe("atticus map render <repo>", () => {
  it("renders the same bytes from the catalog alone, and removes a page nothing renders any more", async () => {
    const root = await metarepo();
    expect(await write(root)).toBe(0);
    const before = files(join(root, "map", "forge-ledger"));
    writeFileSync(join(root, "map", "forge-ledger", "flows", "gone.md"), "an old flow\n");
    const o = io();
    expect(await mapRenderCommand(root, "forge-ledger", {}, o.io)).toBe(0);
    expect(files(join(root, "map", "forge-ledger"))).toEqual(before);
    expect(o.out.join("\n")).toMatch(/map\/forge-ledger\/map\.md/);
  });

  it("says what to run when the repo has nothing in the catalog yet", async () => {
    const root = await metarepo();
    const o = io();
    expect(await mapRenderCommand(root, "forge-unknown", {}, o.io)).toBe(2);
    expect(o.err.join("\n")).toMatch(/atticus verify forge-unknown --write/);
  });

  it("in a repo adopted in place, writes .atticus/map/ with links relative to the repo's own files", async () => {
    const root = mkdtempSync(join(tmpdir(), "atticus-map-adopted-"));
    cpSync(join(VERIFY, "repo"), root, { recursive: true });
    mkdirSync(join(root, ".atticus", "org-pack", "profiles", "forge"), { recursive: true });
    writeFileSync(
      join(root, ".atticus", "org-pack", "profiles", "forge", "repos.manifest.yaml"),
      "schemaVersion: 1\nplatform: forge\nrepos:\n  - { id: forge-ledger, url: ., type: spring-boot, owner: team-ledger, component: ledger-api }\n",
    );
    writeFileSync(
      join(root, ".atticus", "org-pack", "sources.yaml"),
      "schemaVersion: 1\nlayout: { catalog: .atticus/catalog, openspec: .atticus/openspec }\n",
    );
    mkdirSync(join(root, ".atticus", "facts"), { recursive: true });
    writeFileSync(
      join(root, ".atticus", "facts", "forge-ledger.jsonl"),
      readFileSync(join(VERIFY, "forge-ledger.facts.jsonl"), "utf8"),
    );
    const o = io();
    expect(
      await verifyCommand(root, "forge-ledger", { commit: "0123abc", write: true }, o.io),
    ).toBe(0);
    const md = readFileSync(join(root, ".atticus", "map", "forge-ledger", "map.md"), "utf8");
    expect(md).toContain("](../../../src/main/java/forge/ledger/AccountController.java#L18)");
    expect(existsSync(join(root, ".atticus", "specs", "forge-ledger"))).toBe(true);
    expect(existsSync(join(root, ".atticus", "catalog", "generated", "endpoint"))).toBe(true);
  });
});
