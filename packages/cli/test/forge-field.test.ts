import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CatalogRecord } from "@maycombhq/core";
import { readCatalog } from "@maycombhq/scanner";
import { main } from "../src/main.js";
import { selfcheck } from "../src/selfcheck.js";
import { SHAPE_FLAGS } from "../src/shape-words.js";
import { bigGatewayId, bigRepoId } from "./big-estate.js";
import { seedForgeField, type ForgeField } from "./forge-field.js";

/**
 * Beta.30 (slice 9): the field-shaped fixture (fixtures/forge-field) holds every shape a field
 * report has named, and the map built from it has each: so a suite seeded from it tests them.
 * Invented Forge names only; no network.
 */

let dir: string;
let e: ForgeField & { root: string };
let records: CatalogRecord[];
let seconds = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "b30-fd-shape-"));
  const t = Date.now();
  e = await seedForgeField(dir);
  seconds = (Date.now() - t) / 1000;
  records = (await readCatalog(join(e.root, "catalog", "generated"))).records;
}, 300_000);
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const ev = (r: CatalogRecord) => r.evidence as { repo?: string; path?: string; line?: number }[];
const interfaces = () =>
  records.filter((r) => r.kind === "Interface") as (CatalogRecord & {
    from: string;
    to: string;
    method?: string;
  })[];

describe("fixtures/forge-field", () => {
  it("seeds in seconds, every clone at the commit its facts cite", async () => {
    expect(seconds).toBeLessThan(120);
    expect(Object.keys(e.commits).sort()).toEqual(e.clones);
    expect(records.length).toBeGreaterThan(300);
  });

  it("lists ssh and https origins, a repo with no System, and an id with dots", async () => {
    const manifest = await readFile(
      join(e.root, "org-pack/profiles/github/repos.manifest.yaml"),
      "utf8",
    );
    expect(manifest).toMatch(/url: git@git\.example\.test:forge\//);
    expect(manifest).toMatch(/url: https:\/\/git\.example\.test\/forge\//);
    const block = (id: string) =>
      manifest.split(/\n(?= {2}- id: )/).find((b) => b.includes(`- id: ${id}\n`))!;
    expect(block("forge-nosystem-svc")).not.toMatch(/system:/);
    // The repo with dots and the one with no System are read, and on the map.
    for (const repo of ["forge.instruments.svc", "forge-nosystem-svc"])
      expect(
        records.some((r) => r.kind === "Endpoint" && ev(r).some((x) => x.repo === repo)),
        repo,
      ).toBe(true);
  });

  it("holds nested payload fields", () => {
    const schema = records.find(
      (r) => r.kind === "Schema" && ev(r).some((x) => x.repo === "forge-nested-svc"),
    );
    expect(JSON.stringify(schema)).toContain("customer.address.city");
  });

  it("joins gateway proxies whose targets are deploy tokens, @name@ and ${NAME} alike", () => {
    // Gateway g fronts service g; the last one writes its target as ${TARGET_URL}.
    for (const g of [0, 2])
      expect(
        interfaces().filter((r) => r.from === bigGatewayId(g) && r.to === bigRepoId(g)).length,
        bigGatewayId(g),
      ).toBeGreaterThan(0);
  });

  it("keeps the calls whose host is a deploy token nothing sets as loose ends, the token named", () => {
    const loose = records.filter(
      (r) =>
        r.kind === "Unresolved" && /@forgeTargetUrl\d@/.test(String((r as { raw?: string }).raw)),
    );
    expect(loose.length).toBeGreaterThan(0);
  });

  /**
   * Found by this fixture (beta.30 slice 9), fixed by ADR 0124 addendum E-ids (the owner,
   * 2026-11-19): a call the join leaves loose was the catalog's `Unresolved` record
   * `unresolved.<fact id>`, with no repo in it, so two repos whose facts both had a loose call
   * `c-1` made one record and impact's "loose end Atticus couldn't follow"
   * (packages/index/src/graph.ts) never named the other. The id is `unresolved.<repo>.<fact id>`
   * now. Checked by what each record cites, never by its id.
   */
  it("has a record for every repo's loose call, when two repos have a call of the same id", async () => {
    const corrections = new Set<string>();
    const facts: {
      repo: string;
      id: string;
      host?: string;
      kind: string;
      cite: { file: string; line: number };
    }[] = [];
    for (const n of await readdir(join(e.root, "facts"))) {
      const text = await readFile(join(e.root, "facts", n), "utf8");
      const lines = text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, string>);
      if (n.endsWith(".corrections.jsonl"))
        for (const l of lines) corrections.add(`${n.split(".corrections")[0]} ${l.fact}`);
      else if (/^[^]+\.jsonl$/.test(n) && !n.includes(".reviewed."))
        facts.push(...(lines as unknown as typeof facts));
    }
    // Calls to the outside vendor and to deploy tokens nothing sets, that no person paired.
    const want = facts
      .filter(
        (f) =>
          f.kind === "call" &&
          /^(@forgeTargetUrl\d@|api\.northwind-pay\.example)$/.test(f.host ?? ""),
      )
      .filter((f) => !corrections.has(`${f.repo} ${f.id}`))
      .map((f) => `${f.repo} ${f.cite.file}:${f.cite.line}`);
    // By what each Unresolved record cites (repo, file and line), never by its id, so this
    // holds whatever the ids become.
    const got = new Set(
      records
        .filter((r) => r.kind === "Unresolved")
        .flatMap((r) => ev(r).map((x) => `${x.repo} ${x.path}:${x.line}`)),
    );
    expect(want.length).toBeGreaterThan(0);
    expect(want.filter((w) => !got.has(w))).toEqual([]);
  });

  it("has a topic with consumers in two repos, both drawn", () => {
    const t = e.topic!;
    expect(t.listeners).toHaveLength(2);
    for (const to of t.listeners)
      expect(
        interfaces().some((r) => r.from === t.publisher && r.to === to),
        `${t.publisher} → ${to}`,
      ).toBe(true);
  });

  it("has hand pairings, a legacy slot from before the upgrade, and a call joined to the wrong box", async () => {
    expect(e.links).toBeGreaterThan(0);
    expect(e.legacy).toHaveLength(1);
    const slot = JSON.parse(
      await readFile(join(e.root, "catalog/sources/readers", `${e.legacy[0]}.json`), "utf8"),
    ) as { status: string; records: unknown[] };
    expect(slot.status).toBe("legacy");
    expect(slot.records.length).toBeGreaterThan(0);
    const w = e.wrongBox!;
    // Joined by its address to the box it names; the box it really goes to serves the same API.
    expect(interfaces().some((r) => r.from === w.from && r.to === w.joins)).toBe(true);
    expect(
      records.some(
        (r) =>
          r.kind === "Endpoint" &&
          ev(r).some((x) => x.repo === w.goes && x.path?.endsWith("WrongBoxController.java")),
      ),
    ).toBe(true);
  });

  it("lists an empty repo and a repo nobody read", () => {
    expect(existsSync(join(e.root, "workspace", e.emptyRepo!, ".git"))).toBe(true);
    for (const repo of [e.emptyRepo!, e.unreadRepo!]) {
      expect(e.manifest).toContain(repo);
      expect(existsSync(join(e.root, "facts", `${repo}.jsonl`))).toBe(false);
    }
  });

  it("selfcheck passes and its shape card names every flag", async () => {
    const s = await selfcheck(e.root, { platform: "linux", quick: true });
    expect(s.card.flags).toEqual([...SHAPE_FLAGS]);
    expect(s.checks.filter((c) => c.state === "failed")).toEqual([]);
  }, 120_000);

  it("the door check counts the ids its requirements cite: a topic's consumer, an unread repo, an id with dots", async () => {
    const text = (
      await readFile(join(e.root, "openspec/changes", e.change, "requirements.md"), "utf8")
    ).replace(
      "| Does anything else read the topic",
      "| Does the instruments service read it? | `forge.instruments.svc` | application-architect-naysayer | ari | No | answered |\n| Does anything else read the topic",
    );
    const file = join(dir, "requirements.md");
    await writeFile(file, text);
    const out: string[] = [];
    const code = await main(["change", "new", "--from", file, "--check", "--root", e.root], {
      out: (l) => out.push(l),
      err: (l) => out.push(l),
    });
    expect(code, out.join("\n")).toBe(0);
    expect(out.join("\n")).toContain(
      "passes: 5 questions (5 answered, 0 accepted), 4 ids in the map, 0 planned.",
    );
  }, 120_000);
});
