import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listUndo, undoDirOf } from "@maycombhq/scanner";
import { listHooks } from "../src/catalog-build-commands.js";
import { linkEstate, PROXY, type Iface, type LinkEstate } from "./link-edit-estate.js";

/**
 * Beta.28, Edit the map (the owner's ask of 2026-11-12: "I need to be able to update on the map
 * like delete arrows and add arrows in one go and click a button"). POST /api/map/edits (C4
 * 3.13.0, additive) takes the changes the person staged on the canvas: a delete is Delete this
 * link's curated suppress of each Interface behind the link, an add is exactly what Declare a
 * link… writes to the profile, a redirect is both. It checks every change first (nothing is
 * written when one can't be, each said by its place in the list), writes them all, then builds
 * the catalog once; a write that fails takes back the ones written before it and builds nothing.
 * The job's result names the caller repos the changes touch, for one Copilot "Read it again".
 * The metarepo is `link-edit-estate.ts`'s. Files only, no network (CLAUDE.md rule 5).
 */

let e: LinkEstate;
let root: string;
let lineless: Iface;
let lined: Iface;
const PROFILE = () => join(root, "org-pack", "profiles", "forge", "profile.yaml");
const decisionsDir = () => join(root, "catalog", "curated", "curateddecision");
const decisions = () =>
  existsSync(decisionsDir()) ? readdirSync(decisionsDir()).filter((n) => n.endsWith(".yaml")) : [];
/** The newest build kept to undo (each build that writes keeps one). */
const lastBuild = async () => (await listUndo(await undoDirOf(root)))[0]?.n ?? 0;

const GET_PAYMENT = "GET /northwind-pay/1.0/payments/{id}";
const POST_PAYMENT = "POST /northwind-pay/1.0/payments";

beforeAll(async () => {
  e = await linkEstate("atticus-map-edits-");
  ({ root, lineless, lined } = e);
}, 300_000);
afterAll(async () => {
  listHooks.afterList = undefined;
  await e?.close();
});

describe("Edit the map: POST /api/map/edits (beta.28)", () => {
  it("refuses a body that isn't a list of changes", async () => {
    expect((await e.call("/api/map/edits", "POST", { edits: [] })).status).toBe(400);
    expect((await e.call("/api/map/edits", "POST", { edits: [{ kind: "move" }] })).status).toBe(
      400,
    );
    expect(
      (
        await e.call("/api/map/edits", "POST", {
          edits: [{ kind: "redirect", delete: { interfaces: [lined.id], from: "a", to: "b" } }],
        })
      ).status,
    ).toBe(400);
  });

  it("says every change that can't be made, by its place, and writes nothing", async () => {
    const profile = readFileSync(PROFILE(), "utf8");
    const before = await lastBuild();
    const r = await e.call("/api/map/edits", "POST", {
      edits: [
        { kind: "delete", delete: { interfaces: ["if-nothing"], from: "a", to: "b" } },
        { kind: "add", add: { kind: "call", system: "harbor-nowhere", route: GET_PAYMENT } },
        { kind: "add", add: { kind: "call", system: "northwind-pay", route: GET_PAYMENT } },
        // The same declaration twice in one list: the second can't be written.
        { kind: "add", add: { kind: "call", system: "northwind-pay", route: GET_PAYMENT } },
        // A system whose repos the manifests list says its topics in its code (as Declare refuses).
        {
          kind: "add",
          add: { kind: "topic", system: "payments", topic: "forge.refunds", side: "publishes" },
        },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    const problems = r.body.problems as { edit: number; message: string }[];
    expect(problems.map((p) => p.edit)).toEqual([0, 1, 3, 4]);
    expect(problems[0]!.message).toContain("if-nothing");
    expect(problems[1]!.message).toContain("harbor-nowhere");
    expect(String(r.body.detail)).toContain("Nothing was written");
    expect(readFileSync(PROFILE(), "utf8")).toBe(profile);
    expect(decisions()).toEqual([]);
    expect(await lastBuild()).toBe(before);
  });

  it("takes back what it wrote and builds nothing when a write fails part way", async () => {
    const profile = readFileSync(PROFILE(), "utf8");
    const before = await lastBuild();
    // Between the check and the write, the same call is declared in the profile by hand: the
    // add can't be written once the delete before it is.
    listHooks.afterList = async () => {
      writeFileSync(
        PROFILE(),
        profile.replace(
          "    aliases: [api.northwind-pay.example, devapi.northwind-pay.example]\n",
          `    aliases: [api.northwind-pay.example, devapi.northwind-pay.example]\n    calls:\n      - { route: ${POST_PAYMENT} }\n`,
        ),
      );
    };
    const ended = await e.job("/api/map/edits", {
      edits: [
        {
          kind: "redirect",
          delete: { interfaces: [lined.id], from: "northwind-pay-proxy", to: "payments-api" },
          add: { kind: "call", system: "northwind-pay", route: POST_PAYMENT },
        },
      ],
    });
    expect(ended.state).toBe("failed");
    expect(ended.result?.code).toBe(1);
    expect(ended.result?.built).toBe(false);
    const edits = ended.result?.edits as { edit: number; state: string; message?: string }[];
    expect(edits).toEqual([
      expect.objectContaining({
        edit: 0,
        state: "failed",
        message: expect.stringContaining(POST_PAYMENT),
      }),
    ]);
    expect(ended.result?.lines.join("\n")).toContain("Nothing was built");
    // The delete written before it is taken back; the profile is as the hand left it.
    expect(decisions()).toEqual([]);
    expect(await lastBuild()).toBe(before);
    expect((await e.interfaces()).some((i) => i.id === lined.id)).toBe(true);
    writeFileSync(PROFILE(), profile);
  }, 240_000);

  it("saves a lineless delete, a redirect and an add, and builds the catalog once", async () => {
    const before = await lastBuild();
    const ended = await e.job("/api/map/edits", {
      edits: [
        {
          kind: "delete",
          delete: { interfaces: [lineless.id], from: "northwind-pay-proxy", to: "refunds-api" },
        },
        {
          kind: "redirect",
          delete: { interfaces: [lined.id], from: "northwind-pay-proxy", to: "payments-api" },
          add: { kind: "call", system: "northwind-pay", route: POST_PAYMENT },
        },
        { kind: "add", add: { kind: "call", system: "northwind-pay", route: GET_PAYMENT } },
      ],
    });
    expect(ended.state, JSON.stringify(ended)).toBe("done");
    expect(ended.result?.code, ended.result?.lines.join("\n")).toBe(0);
    expect(ended.result?.built).toBe(true);
    expect((ended.result?.edits as { state: string }[]).map((x) => x.state)).toEqual([
      "saved",
      "saved",
      "saved",
    ]);
    // The caller repos the changes touch: the proxy's (the deletes'); Northwind Pay has none.
    expect(ended.result?.callers).toEqual([PROXY]);
    // One build, at the end.
    expect(await lastBuild()).toBe(before + 1);
    const now = await e.interfaces();
    expect(now.some((i) => i.id === lineless.id)).toBe(false);
    expect(now.some((i) => i.id === lined.id)).toBe(false);
    // The deletes are Delete this link's decisions (Deleted links lists them, with Bring back).
    const listed = (await e.call("/api/links/deleted")).body.links as {
      decisions: { target: string }[];
    }[];
    expect(listed.flatMap((l) => l.decisions.map((d) => d.target)).sort()).toEqual(
      [lineless.id, lined.id].sort(),
    );
    // The adds are Declare a link…'s lines in the profile, with who and when.
    const profile = readFileSync(PROFILE(), "utf8");
    expect(profile).toMatch(
      /route: POST \/northwind-pay\/1\.0\/payments\n\s+# declared by pat on /,
    );
    expect(profile).toContain(`route: ${GET_PAYMENT}`);
    // The box's corrections list them, with Undo, as for any declaration.
    const box = (await e.call("/api/boxes/corrections?system=northwind-pay")).body.items as {
      says: string;
    }[];
    expect(box.map((x) => x.says).sort()).toEqual([
      `calls ${GET_PAYMENT}`,
      `calls ${POST_PAYMENT}`,
    ]);
  }, 240_000);

  it("keeps the deletes gone and the adds drawn through a later verify --write and build", async () => {
    // The proxy read from its facts again: its path-guessed arrows are derived again, and the
    // declared calls are joined through its routes.
    await e.verify(PROXY);
    const { main } = await import("../src/main.js");
    const said: string[] = [];
    expect(
      await main(["catalog", "build", "--root", root], {
        out: (l) => said.push(l),
        err: (l) => said.push(l),
      }),
      said.join("\n"),
    ).toBe(0);
    const now = await e.interfaces();
    expect(now.some((i) => i.id === lineless.id)).toBe(false);
    expect(now.some((i) => i.id === lined.id)).toBe(false);
    // Each declared call is an Interface from Northwind Pay through the proxy's route.
    const declared = now.filter((i) => i.from === "northwind-pay");
    expect(declared.map((i) => `${i.method} ${i.normalizedPath}`).sort()).toEqual(
      expect.arrayContaining([expect.stringMatching(/^GET /), expect.stringMatching(/^POST /)]),
    );
  }, 300_000);
});
