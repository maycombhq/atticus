import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { declareArrow } from "@maycombhq/core";
import { buildAndWrite } from "@maycombhq/scanner";
import { createHash } from "node:crypto";
import { reconnectEstate, A, B, FIX, type ReconnectEstate } from "./reconnect-estate.js";

/**
 * ADR 0204's migration: a beta.28.5 metarepo (hand pairings, a declared gateway route and a
 * declared topic, profile version 2) is opened and built by beta.30 and every file is byte for
 * byte the same apart from the loose ends' ids (ADR 0124 addendum E-ids: the repo in each); one
 * declared arrow then raises only the profile's version and adds its item, and the catalog gains
 * exactly its Interface.
 */

const PROFILE = ["org-pack", "profiles", "forge", "profile.yaml"];
let g: ReconnectEstate;
const files = (dir: string) => {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      // Keys with "/" on every machine, as PROFILE.join("/") and the expected lists are.
      else out.set(relative(g.root, p).split(sep).join("/"), readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out;
};
const tree = () =>
  new Map([
    ...files(join(g.root, "org-pack")),
    ...files(join(g.root, "catalog")),
    ...files(join(g.root, "facts")),
  ]);

beforeAll(async () => {
  g = await reconnectEstate("b30-cn-upgrade-");
  // What a beta.28.5 profile can hold: a topic (version 2) and a declared gateway route.
  const p = join(g.root, ...PROFILE);
  writeFileSync(
    p,
    readFileSync(p, "utf8")
      .replace("schemaVersion: 1", "schemaVersion: 2")
      .replace(
        "  - { id: northwind-cards, name: Northwind Cards, boundary: vendor, aliases: [] }",
        [
          "  - id: northwind-cards",
          "    name: Northwind Cards",
          "    boundary: vendor",
          "    aliases: []",
          "    topics: [northwind.cards.settled]",
          "    calls:",
          "      - route: GET /billing/v1/statements/{id} # declared by sam on 2026-11-10",
        ].join("\n"),
      ),
  );
  const b = await buildAndWrite(g.root, { command: "atticus catalog build" });
  expect(b.guard.refused).toBeUndefined();
}, 300_000);
afterAll(async () => g?.close(), 120_000);

describe("upgrade of a beta.28.5 metarepo (ADR 0204, Migration)", () => {
  // The rule of the comparison (the whole-release review of beta.30): beta.30 builds what the tag
  // v2.0.0-beta.28.5 built, but for the one thing ADR 0124's addendum E-ids changed on purpose.
  // A loose end's id carries its repo (`unresolved.<repo>.<fact id>`, was `unresolved.<fact id>`),
  // so its file has that name and its `id:` line that id. With each new id read back as the old
  // one, every record file and stored read is byte for byte beta.28.5's. `build.json` is left out
  // of the bytes compared: it lists each file by path and hash and names the build's version, so
  // it differs wherever an id does; that it is there is still checked.
  it("builds the catalog beta.28.5 built, byte for byte but for the loose ends' ids (its hashes, built by the tag v2.0.0-beta.28.5)", async () => {
    const golden = JSON.parse(
      readFileSync(join(FIX, "expected", "catalog-beta28.5.json"), "utf8"),
    ) as { files: Record<string, string> };
    const BUILD = "catalog/sources/build.json";
    // The repos as an id names them (dots made dashes), from the stored reads on file.
    const repos = [...files(join(g.root, "catalog", "sources", "facts")).keys()]
      .map((k) => /([^/\\]+)\.meta\.json$/.exec(k)?.[1])
      .filter((r): r is string => !!r)
      .map((r) => r.replace(/\./g, "-"));
    const eIds = new RegExp(
      `\\bunresolved\\.(?:${repos.map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\.`,
      "g",
    );
    const asBefore = (text: string) => text.replace(eIds, "unresolved.");
    const now: Record<string, string> = {};
    let renamed = 0;
    for (const [k, v] of files(join(g.root, "catalog"))) {
      const key = asBefore(k.split("\\").join("/"));
      if (key !== k.split("\\").join("/")) renamed++;
      now[key] = createHash("sha256").update(asBefore(v)).digest("hex");
    }
    expect(Object.keys(now).sort()).toEqual(Object.keys(golden.files).sort());
    for (const [k, v] of Object.entries(golden.files)) if (k !== BUILD) expect(now[k], k).toBe(v);
    // The rename is the one E-ids makes, and only it: the estate's one loose end.
    expect(renamed).toBe(1);
    expect(now).toHaveProperty(["catalog/generated/unresolved/unresolved.call-get-fees-id.yaml"]);
  }, 300_000);

  it("builds every file byte for byte the same until an arrow is declared", async () => {
    const before = tree();
    const b = await buildAndWrite(g.root, { command: "atticus catalog build" });
    expect(b.guard.refused).toBeUndefined();
    expect(b.build.declaredSuperseded).toBeUndefined();
    expect(b.build.declaredOrphaned).toBeUndefined();
    const after = tree();
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, v] of before) expect(after.get(k), k).toBe(v);
    // No record of the build is a declared arrow.
    expect(b.build.records.some((r) => r.flags?.includes("declared-link"))).toBe(false);
  }, 300_000);

  it("one declared arrow raises only the profile's version and adds its item", async () => {
    const before = tree();
    await declareArrow(
      g.root,
      { from: { repo: A }, to: { repo: B }, why: "Orders posts holds to the ledger." },
      { by: "pat", at: "2026-11-18T10:02:00Z", platform: "forge" },
    );
    const rel = PROFILE.join("/");
    const was = before.get(rel)!;
    const now = readFileSync(join(g.root, ...PROFILE), "utf8");
    expect(now.startsWith(was.replace("schemaVersion: 2", "schemaVersion: 3"))).toBe(true);
    expect(now.slice(was.length)).toMatch(/^links:\n {2}- from: \{ repo: forge-orders \}\n/);
    const b = await buildAndWrite(g.root, { command: "atticus catalog build" });
    expect(b.guard.refused).toBeUndefined();
    const after = tree();
    const changed = [...after.keys()].filter((k) => after.get(k) !== before.get(k)).sort();
    const added = changed.filter((k) => !before.has(k));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^catalog\/generated\/interface\/if-[0-9a-f]{16}\.yaml$/);
    expect(after.get(added[0]!)).toContain("declared-link");
    // Beside it, only the profile and the build's own manifest.
    expect(changed.filter((k) => before.has(k))).toEqual(
      [rel, ...changed.filter((k) => /build\.json$/.test(k))].sort(),
    );
  }, 300_000);
});
