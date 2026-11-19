import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Api } from "@maycombhq/core";
import { readBuildReport } from "@maycombhq/scanner";
import {
  A,
  B,
  C,
  CALLS,
  GATEWAY,
  VENDOR,
  reconnectEstate,
  type Json,
  type ReconnectEstate,
} from "./reconnect-estate.js";

/**
 * ADR 0204 decisions 1 and 2 on the reconnect estate (fixtures/reconnect, invented): GET
 * /api/connect chooses `calls`, `connected`, `declared`, `declare` or `needs`, the direction as
 * asked; a declared arrow is one item of the profile's links, written and built in one job of
 * POST /api/map/edits, drawn as an asserted Interface flagged `declared-link`, refused (409) over
 * a real call, taken back by Undo, and not drawn once the code shows the call (Retire it then).
 */

const PROFILE = ["org-pack", "profiles", "forge", "profile.yaml"];
const WHY = "Northwind Cards settles into the ledger by its nightly push.";
const OUTSIDE = "northwind-cards";
let g: ReconnectEstate;
const profile = () => readFileSync(join(g.root, ...PROFILE), "utf8");
const connect = async (from: string, to: string) => {
  const r = await g.call(`/api/connect?from=${from}&to=${to}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return Api.ConnectView.parse(r.body);
};
const job = async (path: string, body: unknown) => {
  const started = await g.call(path, "POST", body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  let j: Json = {};
  for (let n = 0; n < 2400; n++) {
    j = (await g.call(`/api/jobs/${String(started.body.jobId)}`)).body;
    if (j.state !== "running" && j.state !== "queued") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return j;
};
const declared = async () =>
  (await g.interfaces()).filter((i) => i.flags?.includes("declared-link"));

beforeAll(async () => {
  g = await reconnectEstate("b30-cn-api-");
  // A product system with no repo yet (planned), for `no-repo`.
  writeFileSync(
    join(g.root, ...PROFILE),
    profile().replace(
      "environments:",
      "  - { id: forge-rewards, name: Forge Rewards, boundary: product, aliases: [] }\nenvironments:",
    ),
  );
}, 300_000);
afterAll(async () => g?.close(), 120_000);

describe("GET /api/connect (ADR 0204 1.3, 3.1, B.1, B.2)", () => {
  it("lists the caller's calls that go elsewhere for a box none goes to: calls", async () => {
    const v = await connect(`repo:${A}`, `repo:${B}`);
    expect(v.mechanism).toBe("calls");
    expect(v.from).toEqual({ repo: A });
    expect(v.to).toEqual({ repo: B });
    expect(v.candidates?.calls.filter((c) => c.joins === C).length).toBeGreaterThan(0);
    // B.1: those going to another box first.
    expect(v.candidates!.calls[0]!.joins).toBeDefined();
  }, 120_000);

  it("says connected when every call goes to the callee, and declare where no call could", async () => {
    const gw = await connect(`repo:${GATEWAY}`, `repo:${C}`);
    expect(gw.mechanism).toBe("connected");
    expect(gw.existing).toBeGreaterThan(0);
    for (const [from, to] of [
      [`system:${OUTSIDE}`, `repo:${B}`],
      [`system:${OUTSIDE}`, `system:${VENDOR}`],
    ] as const) {
      const v = await connect(from, to);
      expect(v.mechanism, `${from} → ${to}`).toBe("declare");
      expect(v.candidates).toBeUndefined();
    }
  }, 120_000);

  it("names what is missing: a system with no repo, one only the code names", async () => {
    const none = await connect(`repo:${A}`, "system:forge-rewards");
    expect(none.mechanism).toBe("needs");
    expect(none.needs).toEqual([{ need: "no-repo", end: "to", label: "Forge Rewards" }]);
    const named = await connect("system:harbor-unknown", `repo:${B}`);
    expect(named.needs).toEqual([{ need: "add-system", end: "from", label: "harbor-unknown" }]);
    expect((await g.call(`/api/connect?from=repo:${A}&to=repo:${A}`)).status).toBe(400);
    expect((await g.call(`/api/connect?from=${A}&to=repo:${B}`)).status).toBe(400);
  }, 120_000);

  it("never turns the direction round, for every pair of box kinds", async () => {
    const kinds = [`repo:${A}`, `repo:${GATEWAY}`, `system:${OUTSIDE}`, `system:${VENDOR}`];
    for (const from of kinds)
      for (const to of kinds) {
        if (from === to) continue;
        const v = await connect(from, to);
        const say = (b: Api.LinkBoxT) => (b.repo ? `repo:${b.repo}` : `system:${b.system}`);
        expect([say(v.from), say(v.to)], `${from} → ${to}`).toEqual([from, to]);
      }
  }, 300_000);
});

describe("a declared arrow (ADR 0204 1.4 to 1.7, 2.2, 2.4)", () => {
  const link = { from: { system: OUTSIDE }, to: { repo: B }, why: WHY };

  it("previews its lines, then writes and builds in one job, drawn as the person's word", async () => {
    const before = profile();
    const p = await g.call("/api/declared-links", "POST", { kind: "link", ...link, preview: true });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const r = Api.FileChangeResult.parse(p.body);
    expect(r.written).toBe(false);
    expect(profile()).toBe(before);
    const lines = r.files[0]!.changes.map((c) => c.now ?? "").join("\n");
    expect(lines).toContain(`why: ${WHY}`);
    const j = await job("/api/map/edits", {
      edits: [{ kind: "add", add: { kind: "link", ...link } }],
    });
    expect(j.state, JSON.stringify(j)).toBe("done");
    expect(j.result.built, (j.result.lines as string[]).join("\n")).toBe(true);
    const written = Api.MapEditsResult.parse(j.result).wrote!;
    expect(written).toHaveLength(1);
    const p2 = parse(profile()) as { schemaVersion: number; links: Json[] };
    expect(p2.schemaVersion).toBe(3);
    expect(p2.links).toEqual([
      expect.objectContaining({ from: { system: OUTSIDE }, to: { repo: B }, why: WHY, by: "pat" }),
    ]);
    const d = await declared();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      from: OUTSIDE,
      confidence: "asserted",
      via: "other",
      normalizedPath: "/**",
      evidence: [{ source: "manual", path: "profiles/forge/profile.yaml", by: "pat" }],
    });
    const v = await connect(`system:${OUTSIDE}`, `repo:${B}`);
    expect(v.mechanism).toBe("declared");
    expect(v.declared).toMatchObject({ why: WHY, by: "pat" });
    // Listed at either end under Corrections and declarations.
    for (const q of [`repo=${B}`, `system=${OUTSIDE}`]) {
      const c = Api.BoxCorrections.parse((await g.call(`/api/boxes/corrections?${q}`)).body);
      expect(
        c.items.filter((x) => x.kind === "arrow"),
        q,
      ).toHaveLength(1);
    }
    // Undo: exactly what it wrote, then one build.
    const u = await job("/api/map/edits/undo", { wrote: written });
    expect(u.state, JSON.stringify(u)).toBe("done");
    expect(u.result.built).toBe(true);
    // Byte for byte as before: the version the arrow raised is put back too (the review).
    expect(profile()).toBe(before);
    expect(await declared()).toHaveLength(0);
  }, 300_000);

  it("Undo removes nothing when the arrow changed since, and says so", async () => {
    const j = await job("/api/map/edits", {
      edits: [{ kind: "add", add: { kind: "link", ...link } }],
    });
    const written = Api.MapEditsResult.parse(j.result).wrote!;
    writeFileSync(join(g.root, ...PROFILE), profile().replace(WHY, `${WHY} Checked again.`));
    const u = await job("/api/map/edits/undo", { wrote: written });
    expect(u.result.code).toBe(1);
    expect((u.result.lines as string[]).join("\n")).toContain("Nothing was undone");
    expect(profile()).toContain("Checked again.");
    const r = await g.call("/api/declared-links/undo", "POST", {
      kind: "link",
      from: link.from,
      to: link.to,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(parse(profile())).not.toHaveProperty("links");
  }, 300_000);

  it("is refused (409) over a real call, with the connected words", async () => {
    const r = await g.call("/api/declared-links", "POST", {
      kind: "link",
      from: { repo: A },
      to: { repo: C },
      why: "Orders calls billing, said again.",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(String(r.body.detail)).toMatch(
      new RegExp(`^${A} already calls ${C}: \\d+ calls? read from code`),
    );
  }, 120_000);

  it("stops being drawn once the code shows the call, and Retire takes its item away", async () => {
    const mine = { from: { repo: A }, to: { repo: B }, why: "Orders posts holds to the ledger." };
    const j = await job("/api/map/edits", {
      edits: [{ kind: "add", add: { kind: "link", ...mine } }],
    });
    expect(j.result.built, (j.result.lines as string[]).join("\n")).toBe(true);
    expect(await declared()).toHaveLength(1);
    // The review (B.1): the declared arrow never hides A's calls that could be B's.
    const listed = await connect(`repo:${A}`, `repo:${B}`);
    expect(listed.mechanism).toBe("calls");
    expect(listed.declared?.why).toBe("Orders posts holds to the ledger.");
    expect(listed.candidates?.calls.some((c) => c.joins === C)).toBe(true);
    // A person pairs one of A's calls with B: a real call A → B, so the declared one goes.
    const pair = await job("/api/map/edits", {
      edits: [{ kind: "add", pair: { from: A, to: { repo: B }, pairs: [CALLS.mine] } }],
    });
    expect(pair.result.built, (pair.result.lines as string[]).join("\n")).toBe(true);
    expect(await declared()).toHaveLength(0);
    expect((await g.arrows())[B]).toBeGreaterThan(0);
    expect((await readBuildReport(g.root))?.declaredSuperseded).toEqual([
      expect.objectContaining({ from: `repo:${A}`, to: `repo:${B}`, by: "pat" }),
    ]);
    const v = await connect(`repo:${A}`, `repo:${B}`);
    expect(v.mechanism).toBe("declared");
    expect(v.superseded?.calls).toBeGreaterThan(0);
    // Nothing in the profile changed by itself; Retire takes the item.
    expect(profile()).toContain("Orders posts holds to the ledger.");
    const r = await g.call("/api/declared-links/undo", "POST", {
      kind: "link",
      from: mine.from,
      to: mine.to,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(profile()).not.toContain("Orders posts holds to the ledger.");
  }, 300_000);
});

describe("a pairing written and applied in one job (ADR 0204 decision 2)", () => {
  it("writes the pair and builds once, and Undo takes back exactly its line and builds again", async () => {
    const corrections = join(g.root, "facts", `${A}.corrections.jsonl`);
    const before = readFileSync(corrections, "utf8");
    const arrowsBefore = await g.arrows();
    const j = await job("/api/map/edits", {
      edits: [{ kind: "add", pair: { from: A, to: { repo: B }, pairs: [CALLS.theirs] } }],
    });
    expect(j.result.built, (j.result.lines as string[]).join("\n")).toBe(true);
    const wrote = Api.MapEditsResult.parse(j.result).wrote!;
    expect(wrote).toEqual([
      {
        edit: 0,
        file: `facts/${A}.corrections.jsonl`,
        lines: [expect.stringContaining(CALLS.theirs.call)],
      },
    ]);
    expect((await g.arrows())[B]).toBe((arrowsBefore[B] ?? 0) + 1);
    // Undo: the line goes, and the arrow it drew with it, in one build with no confirm asked.
    const u = await job("/api/map/edits/undo", { wrote });
    expect(u.result.built, (u.result.lines as string[]).join("\n")).toBe(true);
    expect(readFileSync(corrections, "utf8")).toBe(before);
    expect(await g.arrows()).toEqual(arrowsBefore);
  }, 300_000);
});

describe("what is missing, fixed in the same write (ADR 0204 3.1, 1.3)", () => {
  it("adds a system only the code names in the arrow's own write, and Undo takes both away", async () => {
    const before = profile();
    const link = {
      kind: "link",
      from: { system: "harbor-unknown" },
      to: { repo: B },
      why: "Harbor reads the ledger's holds each night.",
      addSystem: { name: "Harbor Unknown", boundary: "internal" },
    };
    const p = await g.call("/api/declared-links", "POST", { ...link, preview: true });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const now = Api.FileChangeResult.parse(p.body)
      .files[0]!.changes.map((c) => c.now ?? "")
      .join("\n");
    expect(now).toContain("id: harbor-unknown");
    expect(now).toContain("from: { system: harbor-unknown }");
    const j = await job("/api/map/edits", { edits: [{ kind: "add", add: link }] });
    expect(j.result.built, (j.result.lines as string[]).join("\n")).toBe(true);
    const wrote = Api.MapEditsResult.parse(j.result).wrote!;
    expect(wrote[0]).toMatchObject({ addedSystem: "harbor-unknown" });
    expect((await declared()).map((x) => x.from)).toContain("harbor-unknown");
    const u = await job("/api/map/edits/undo", { wrote });
    expect(u.result.built, (u.result.lines as string[]).join("\n")).toBe(true);
    expect(profile()).not.toContain("harbor-unknown");
    expect(profile()).toBe(before);
  }, 300_000);

  it("declares the gateway routes an outside system calls, written and undone in one go", async () => {
    const r = await g.call(`/api/declared-links/routes?system=${OUTSIDE}&repo=${GATEWAY}`);
    const say = Api.DeclarableRoutesView.parse(r.body).target!.routes[0]!.say;
    const v = await connect(`system:${OUTSIDE}`, `repo:${GATEWAY}`);
    expect(v.routes).toBe(true);
    // Declare's Undo takes a route back from a system written as a block (as the canvas adds one).
    writeFileSync(
      join(g.root, ...PROFILE),
      profile().replace(
        "  - { id: northwind-cards, name: Northwind Cards, boundary: vendor, aliases: [] }",
        "  - id: northwind-cards\n    name: Northwind Cards\n    boundary: vendor\n    aliases: []",
      ),
    );
    const j = await job("/api/map/edits", {
      edits: [{ kind: "add", add: { kind: "call", system: OUTSIDE, route: say } }],
    });
    expect(j.result.built, (j.result.lines as string[]).join("\n")).toBe(true);
    const wrote = Api.MapEditsResult.parse(j.result).wrote!;
    expect(wrote).toEqual([
      {
        edit: 0,
        file: "org-pack/profiles/forge/profile.yaml",
        route: { system: OUTSIDE, value: say },
      },
    ]);
    const calls = () =>
      (parse(profile()) as { systems: { id: string; calls?: { route?: string }[] }[] }).systems
        .find((x) => x.id === OUTSIDE)
        ?.calls?.map((c) => c.route) ?? [];
    expect(calls()).toContain(say);
    const u = await job("/api/map/edits/undo", { wrote });
    expect(u.state, JSON.stringify(u)).toBe("done");
    expect(calls()).not.toContain(say);
  }, 300_000);
});

describe("Undo keeps to its own (the review of ADR 0204)", () => {
  const link = { from: { system: OUTSIDE }, to: { repo: B }, why: WHY };
  it("leaves a removal it didn't make for a person to confirm, and says so", async () => {
    const j = await job("/api/map/edits", {
      edits: [{ kind: "add", add: { kind: "link", ...link } }],
    });
    expect(j.result.built, (j.result.lines as string[]).join("\n")).toBe(true);
    const wrote = Api.MapEditsResult.parse(j.result).wrote!;
    // A teammate's change pulled meanwhile drops two systems: the build would remove their records.
    const kept = profile();
    writeFileSync(
      join(g.root, ...PROFILE),
      kept
        .split("\n")
        .filter((l) => !/id: (platform|northwind-pay),/.test(l))
        .join("\n"),
    );
    const records = (await g.interfaces()).length;
    const u = await job("/api/map/edits/undo", { wrote });
    expect(u.result.built, (u.result.lines as string[]).join("\n")).toBe(false);
    expect(u.result.refused).toBeDefined();
    // Nothing of the teammate's removals was written unconfirmed.
    expect((await g.interfaces()).length).toBe(records);
    writeFileSync(join(g.root, ...PROFILE), kept.replace(/\nlinks:[\s\S]*$/, "\n"));
  }, 300_000);

  it("takes back only a repo's corrections or a platform's profile", async () => {
    const outside = join(g.root, "..", "b30-cn-not-ours.jsonl");
    writeFileSync(outside, "keep me\n");
    for (const file of ["../b30-cn-not-ours.jsonl", `facts/${A}.jsonl`, "org-pack/runtime.yaml"]) {
      const r = await g.call("/api/map/edits/undo", "POST", {
        wrote: [{ edit: 0, file, lines: ["keep me"] }],
      });
      expect(r.status, file).toBe(400);
    }
    expect(readFileSync(outside, "utf8")).toBe("keep me\n");
  }, 120_000);
});
