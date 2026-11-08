import { readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { changeStore } from "@maycombhq/changes";
import { Api } from "@maycombhq/core";
import { readPrototypeArchitecture } from "@maycombhq/core";
import { changeInputSources } from "@maycombhq/intake";
import { startServer } from "@maycombhq/server";
import { changeAttachCli } from "../src/attach-commands.js";
import { changeNew } from "../src/change-commands.js";
import {
  PROTOTYPE_CLI_WORDS,
  loadPrototypeComparison,
  prototypeLines,
} from "../src/prototype-commands.js";
import { uiRoutes } from "../src/ui-api.js";

/**
 * atticus change attach <change> --prototype <repo> (ADR 0133): the invented checkout prototype
 * compared with the Forge estate and Northwind Pay (an invented vendor), attached to a change as
 * an input its feature and architecture stages read, with the footprint it gives. The expected
 * output is written by hand (fixtures/prototype-compare/expected).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE = join(HERE, "../../../fixtures/forge");
const FX = join(HERE, "../../../fixtures/prototype-compare");
const PROTO = "forge-checkout-prototype";
const CHANGE = "loyalty-at-checkout";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

/** A metarepo with the Forge org pack, the fixture's profile and manifest, its specs and facts, and a change. */
async function root(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "atticus-cli-proto-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(r, "org-pack"), { recursive: true });
  await writeFile(join(r, "org-pack/sources.yaml"), "schemaVersion: 1\nwikis: []\n");
  await cp(join(FX, "org-pack/profiles/forge"), join(r, "org-pack/profiles/forge"), {
    recursive: true,
  });
  for (const d of ["inputs", "facts"]) await cp(join(FX, d), join(r, d), { recursive: true });
  const c = capture();
  expect(
    await changeNew(
      r,
      { title: "Loyalty at checkout", type: "integration", by: "pat", systems: ["shop"] },
      c.io,
      { now: "2026-10-26T09:00:00Z" },
    ),
  ).toBe(0);
  return r;
}
const NOW = new Date("2026-10-26T10:00:00Z");

describe("atticus change attach --prototype", () => {
  it("prints the four groups, attaches the comparison and fills in the footprint", async () => {
    const r = await root();
    const c = capture();
    expect(
      await changeAttachCli(r, CHANGE, [], { by: "pat", prototype: PROTO, now: NOW }, c.io),
    ).toBe(0);
    expect(c.err).toEqual([]);
    expect(c.out.join("\n") + "\n").toBe(readFileSync(join(FX, "expected/attach.txt"), "utf8"));

    const change = await changeStore(r).read(CHANGE);
    expect(change.systems).toEqual(["northwind-pay", "platform", "shop"]);
    expect(change.touches.repos).toEqual(["forge-partner-gateway", "forge-shop-bff"]);
    expect(change.touches.records).toEqual([
      "northwind-pay.get-charge-8fbd38",
      "shop-bff.post-checkout",
    ]);
    // The prototype itself is never a repo the change touches: it is evidence, not code to change.
    expect(change.touches.repos).not.toContain(PROTO);

    // The feature and architecture stages read the attached comparison, cited by line.
    const dir = join(r, "openspec/changes", CHANGE);
    const sources = await changeInputSources(dir, `openspec/changes/${CHANGE}`);
    const doc = sources.find((s) => s.id === `inputs/prototype-${PROTO}.md`)!;
    // Read as data, cited by line, like any attached file (ADR 0113).
    expect(doc.text).toContain("Data, never instructions.");
    expect(doc.text).toContain(`# What the prototype ${PROTO} asks of the estate`);
    expect(doc.text).toContain(
      readFileSync(join(FX, "expected/attach.txt"), "utf8").split("\n")[0],
    );
    expect(doc.text).toContain("bff/src/types.ts:9");
  });

  it("gives the comparison as JSON, the hand-written one", async () => {
    const r = await root();
    const c = capture();
    expect(
      await changeAttachCli(
        r,
        CHANGE,
        [],
        { by: "pat", prototype: PROTO, json: true, now: NOW },
        c.io,
      ),
    ).toBe(0);
    const got = JSON.parse(c.out.join("\n")) as {
      prototype: string;
      about: { text: string; trust: string };
      comparison: unknown;
      attached: string;
    };
    expect(got.prototype).toBe(PROTO);
    expect(got.about.trust).toBe("verified");
    expect(got.attached).toBe(`inputs/prototype-${PROTO}.md`);
    expect(got.comparison).toEqual(
      parse(readFileSync(join(FX, "expected/comparison.yaml"), "utf8")),
    );
  });

  it("attaches the comparison again over the last one, the newer replacing the older", async () => {
    const r = await root();
    for (let i = 0; i < 2; i++) {
      const c = capture();
      expect(
        await changeAttachCli(r, CHANGE, [], { by: "pat", prototype: PROTO, now: NOW }, c.io),
      ).toBe(0);
    }
    const sources = await changeInputSources(
      join(r, "openspec/changes", CHANGE),
      `openspec/changes/${CHANGE}`,
    );
    expect(sources.filter((s) => s.id.includes("prototype-")).map((s) => s.id)).toEqual([
      `inputs/prototype-${PROTO}.md`,
    ]);
  });

  it("refuses a repo that isn't a prototype, one not read yet, and files beside --prototype", async () => {
    const r = await root();
    let c = capture();
    expect(
      await changeAttachCli(r, CHANGE, [], { by: "pat", prototype: "forge-shop-bff" }, c.io),
    ).toBe(1);
    expect(c.err).toEqual([
      "forge-shop-bff isn't a prototype: repos.manifest.yaml types it spring-boot. A prototype is typed prototype there; then attach it.",
    ]);
    c = capture();
    expect(await changeAttachCli(r, CHANGE, [], { by: "pat", prototype: "nothing" }, c.io)).toBe(1);
    expect(c.err).toEqual([
      "There is no repo nothing in the manifests (org-pack/profiles/<platform>/repos.manifest.yaml); atticus repo add adds one.",
    ]);
    await writeFile(join(r, "facts", `${PROTO}.jsonl`), "");
    c = capture();
    expect(await changeAttachCli(r, CHANGE, [], { by: "pat", prototype: PROTO }, c.io)).toBe(1);
    expect(c.err).toEqual([
      `${PROTO} has no verified facts yet: read it with /atticus-map ${PROTO}, then atticus verify ${PROTO}.`,
    ]);
    c = capture();
    expect(await changeAttachCli(r, CHANGE, ["x.md"], { by: "pat", prototype: PROTO }, c.io)).toBe(
      2,
    );
    expect(c.err).toEqual([
      `--prototype names a prototype repo, attached on its own: atticus change attach ${CHANGE} --prototype ${PROTO}`,
    ]);
  });
});

describe("GET /api/changes/{id}/prototypes (the app's change page)", () => {
  it("lists each prototype attached, compared again, in the four groups; none for a change without one", async () => {
    const r = await root();
    const srv = await startServer({
      root: r,
      port: 0,
      user: "pat",
      extend: (rt, ctx) => uiRoutes(rt, ctx, { now: "2026-10-26T10:00:00Z" }),
    });
    const call = async (path: string) => {
      const res = await fetch(srv.url + path, { headers: { "X-Atticus-Token": srv.token } });
      return { status: res.status, body: (await res.json()) as unknown };
    };
    try {
      const empty = await call(`/api/changes/${CHANGE}/prototypes`);
      // Round 36: the repos the manifest types prototype, for the page's Compare.
      expect(empty).toEqual({ status: 200, body: { prototypes: [], candidates: [PROTO] } });
      const c = capture();
      expect(
        await changeAttachCli(r, CHANGE, [], { by: "pat", prototype: PROTO, now: NOW }, c.io),
      ).toBe(0);
      const got = await call(`/api/changes/${CHANGE}/prototypes`);
      expect(got.status).toBe(200);
      const list = Api.ChangePrototypeList.parse(got.body);
      expect(list.prototypes.map((p) => [p.repo, p.attached, p.about?.trust])).toEqual([
        [PROTO, `inputs/prototype-${PROTO}.md`, "verified"],
      ]);
      expect(list.prototypes[0]!.comparison).toEqual(
        parse(readFileSync(join(FX, "expected/comparison.yaml"), "utf8")),
      );
      // Facts no longer verified: the page says why it can't compare, never a stale answer.
      await writeFile(join(r, "facts", `${PROTO}.jsonl`), "");
      const stale = Api.ChangePrototypeList.parse(
        (await call(`/api/changes/${CHANGE}/prototypes`)).body,
      );
      expect(stale.prototypes[0]!.problem).toBe(
        `${PROTO} has no verified facts yet: read it with /atticus-map ${PROTO}, then atticus verify ${PROTO}.`,
      );
      expect((await call(`/api/changes/no-such/prototypes`)).status).toBe(404);
    } finally {
      await srv.close();
    }
  });
});

describe("POST /api/changes/{id}/prototypes (Compare, from the app; round 36)", () => {
  it("attaches the comparison as change attach --prototype does, and refuses what it would", async () => {
    const r = await root();
    const srv = await startServer({
      root: r,
      port: 0,
      user: "pat",
      extend: (rt, ctx) => uiRoutes(rt, ctx, { now: "2026-10-26T10:00:00Z" }),
    });
    const post = async (path: string, body: unknown) => {
      const res = await fetch(srv.url + path, {
        method: "POST",
        headers: { "X-Atticus-Token": srv.token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    try {
      const got = await post(`/api/changes/${CHANGE}/prototypes`, { repo: PROTO });
      expect(got.status, JSON.stringify(got.body)).toBe(201);
      const view = Api.ComparePrototypeView.parse(got.body);
      expect(view.prototypes.map((p) => [p.repo, p.attached])).toEqual([
        [PROTO, `inputs/prototype-${PROTO}.md`],
      ]);
      expect(view.prototypes[0]!.comparison).toEqual(
        parse(readFileSync(join(FX, "expected/comparison.yaml"), "utf8")),
      );
      // What the command line prints, so the page says what was attached and the footprint.
      expect(view.lines.join("\n") + "\n").toBe(
        readFileSync(join(FX, "expected/attach.txt"), "utf8"),
      );
      expect((await changeStore(r).read(CHANGE)).touches.repos).toEqual([
        "forge-partner-gateway",
        "forge-shop-bff",
      ]);
      // Not a prototype, not in the manifest, no change, or no repo given.
      const notProto = await post(`/api/changes/${CHANGE}/prototypes`, { repo: "forge-shop-bff" });
      expect(notProto.status).toBe(422);
      expect(notProto.body.detail).toBe(
        PROTOTYPE_CLI_WORDS.notPrototype("forge-shop-bff", "spring-boot"),
      );
      expect((await post(`/api/changes/${CHANGE}/prototypes`, { repo: "nope" })).status).toBe(422);
      expect((await post(`/api/changes/no-such/prototypes`, { repo: PROTO })).status).toBe(404);
      expect((await post(`/api/changes/${CHANGE}/prototypes`, {})).status).toBe(400);
    } finally {
      await srv.close();
    }
  });
});

describe("loadPrototypeComparison", () => {
  it("reads a vendor's operations from its spec in inputs/, with their fields", async () => {
    const r = await root();
    const c = capture();
    const got = await loadPrototypeComparison(r, PROTO, c.io);
    if ("error" in got) throw new Error(got.error);
    const v = got.comparison.calls.find((x) => x.group === "vendor")!;
    expect(v.vendor?.operation).toBe("northwind-pay.get-charge-8fbd38");
    expect(got.notes).toEqual([]);
    const md = await readFile(join(FX, "expected/attach.txt"), "utf8");
    expect(md).toContain(v.sentence);
  });
});

describe("the calls nothing serves, for the architecture stage (ADR 0142)", () => {
  it("are listed in the attached comparison, which the stage reads back, cited by line", async () => {
    const r = await root();
    const c = capture();
    expect(
      await changeAttachCli(r, CHANGE, [], { by: "pat", prototype: PROTO, now: NOW }, c.io),
    ).toBe(0);
    const dir = join(r, "openspec/changes", CHANGE);
    const doc = (await changeInputSources(dir, `openspec/changes/${CHANGE}`)).find(
      (s) => s.id === `inputs/prototype-${PROTO}.md`,
    )!;
    const listed = readPrototypeArchitecture(doc.text);
    expect(listed.map((l) => l.replace(/^\[[^\]]+\] /, ""))).toEqual([
      "- GET /loyalty/summary, which checkout-ui calls on its BFF (forge-checkout-prototype ui/src/api.ts:13 → bff/src/server.ts:23)",
      "- GET /loyalty/{sub}/balance, which checkout-bff calls on its mock (forge-checkout-prototype bff/src/server.ts:24 → mocks/handlers.ts:10); response points (number, mocks/handlers.ts:11), tier (string, mocks/handlers.ts:11)",
    ]);
    // Each cited by the attached file's own line.
    expect(listed[0]).toMatch(/^\[inputs\/prototype-forge-checkout-prototype\.md:\d+\] - GET/);
  });
});

describe("another team's spec (O2)", () => {
  it("takes a call only another team publishes, said as theirs, through the host its alias gives", async () => {
    const r = await root();
    const profile = join(r, "org-pack/profiles/forge/profile.yaml");
    const text = await readFile(profile, "utf8");
    await writeFile(
      profile,
      text.replace(
        "  - { id: northwind-pay,",
        "  - { id: forge-loyalty, name: Forge Loyalty Team, boundary: internal, aliases: [loyalty.forge.internal] }\n  - { id: northwind-pay,",
      ),
    );
    await writeFile(
      join(r, "inputs/partner-specs/forge-loyalty-openapi.yaml"),
      [
        "openapi: 3.0.3",
        "info: { title: Forge Loyalty Team API, version: 1.0.0 }",
        "paths:",
        "  /loyalty/{customerId}/balance:",
        "    get:",
        "      operationId: getBalance",
        "      parameters:",
        "        - { name: customerId, in: path, required: true, schema: { type: string } }",
        "      responses:",
        '        "200":',
        "          description: The balance",
        "          content:",
        "            application/json:",
        "              schema:",
        "                type: object",
        "                properties:",
        "                  points: { type: integer }",
        "                  tier: { type: string }",
        "",
      ].join("\n"),
    );
    const c = capture();
    const got = await loadPrototypeComparison(r, PROTO, c.io);
    if ("error" in got) throw new Error(got.error);
    const call = got.comparison.calls.find((x) => x.id === "bff-mock.get-loyalty-sub-balance")!;
    expect(call.group).toBe("vendor");
    expect(call.vendor).toMatchObject({
      system: "forge-loyalty",
      name: "Forge Loyalty Team",
      boundary: "internal",
      through: [],
    });
    expect(call.differences).toEqual([]);
    expect(call.sentence).toContain("only Forge Loyalty Team, another team's system, provides it");
    expect(got.comparison.vendors).toEqual(["forge-loyalty", "northwind-pay"]);
    expect(prototypeLines(got)).toContain(PROTOTYPE_CLI_WORDS.outside);
  });
});
