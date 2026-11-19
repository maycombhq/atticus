import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { main } from "../src/main.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "atticus-ask-"));
  await cp(join(FIXTURES, "forge/metarepo"), root, { recursive: true });
  for (const r of parse(readFileSync(join(FIXTURES, "forge/expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) continue;
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
});

const run = async (args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...args, "--root", root], {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

describe("atticus ask", () => {
  it("shows how it read the question and the query, then the answer", async () => {
    const r = await run(["ask", "who calls ledger-api?"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Query: kind:interface to:ledger-api");
    expect(r.out).toMatch(/portal-bff/);
  });

  it("walks impact when the question asks what breaks", async () => {
    const r = await run(["ask", "what breaks if ledger-api changes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Query: impact ledger-api");
  });

  it("names a topic's consumers as impact does (ADR 0201: the trial's question got none)", async () => {
    const r = await run(["ask", "who consumes the topic transfers.completed?"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "Read as: who receives topic.transfers-completed, from what a change to it reaches.",
    );
    expect(r.out).toContain("Query: impact topic.transfers-completed");
    const components = (t: string) =>
      (JSON.parse(t) as { affected: { kind: string; id: string }[] }).affected
        .filter((a) => a.kind === "Component")
        .map((a) => a.id)
        .sort();
    const asked = await run(["ask", "who consumes the topic transfers.completed?", "--json"]);
    const walked = await run(["impact", "topic.transfers-completed", "--json"]);
    expect(components(asked.out)).toEqual(components(walked.out));
    expect(components(asked.out)).toContain("reports-job");
  });

  it("keeps how it read the question in --json, as readAs and query", async () => {
    const r = await run(["ask", "who calls ledger-api?", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { readAs: string; query: string; total: number };
    expect(j.readAs).toBe("Read as: the interfaces whose callee is ledger-api.");
    expect(j.query).toBe("kind:interface to:ledger-api");
    expect(j.total).toBeGreaterThan(0);
  });

  it("says a name the map lacks is not in the map, and never lists every interface", async () => {
    const r = await run(["ask", "who calls forge-portal?"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("forge-portal is not in the map: planned or not read.");
    expect(r.out).toContain("0 records");
    expect(r.out).not.toMatch(/portal-bff|ledger-api/);
    const j = JSON.parse((await run(["ask", "who calls forge-portal?", "--json"])).out) as {
      readAs: string;
      total: number;
    };
    expect(j.total).toBe(0);
    expect(j.readAs).toMatch(/forge-portal is not in the map: planned or not read\.$/);
  });

  it("needs a question", async () => {
    expect((await run(["ask"])).code).toBe(2);
  });
});

describe("atticus guide and atticus site build", () => {
  it("prints a system's guide, and refuses a system the catalog doesn't have", async () => {
    const r = await run(["guide", "ledger"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("# Ledger (ledger)");
    expect(r.out).toContain("## Who it talks to");
    expect((await run(["guide", "atlantis"])).code).toBe(1);
    expect((await run(["guide"])).code).toBe(2);
  });

  it("writes the static site", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atticus-site-cli-"));
    const r = await run(["site", "build", dir, "--title", "Forge catalog"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/5 systems/);
    expect(await readFile(join(dir, "index.html"), "utf8")).toContain("Forge catalog");
  });
});
