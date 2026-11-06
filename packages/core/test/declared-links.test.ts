import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { declaredOf, declareLink, DeclareError, undeclareLink } from "../src/index.js";

/**
 * G3 (ADR 0174): a declared link, written to the profile with who and when as the line's
 * comment, read back with them, and undone exactly. On an invented Forge profile with Northwind
 * Pay (an invented vendor) and the Harbor team's audit system.
 */

const PROFILE = `# The Forge profile (invented).
schemaVersion: 1
platform: forge
name: Forge
systems:
  - id: ledger
    name: Ledger
    boundary: product
  - id: harbor-audit
    name: Harbor audit
    boundary: internal
    owner: team-harbor
  - id: northwind-pay
    name: Northwind Pay
    boundary: vendor
`;

const metarepo = async () => {
  const root = await mkdtemp(join(tmpdir(), "atticus-declared-"));
  await mkdir(join(root, "org-pack/profiles/forge"), { recursive: true });
  await writeFile(join(root, "org-pack/profiles/forge/profile.yaml"), PROFILE);
  return root;
};

const at = "2026-11-06T12:00:00.000Z";

describe("declared links (ADR 0174, G3)", () => {
  it("previews, then writes a topic a team publishes, with who and when, keeping the file's comments", async () => {
    const root = await metarepo();
    const d = {
      kind: "topic" as const,
      system: "harbor-audit",
      topic: "harbor.audit.events",
      side: "publishes" as const,
    };
    const p = await declareLink(root, d, { by: "pat", at, preview: true });
    expect(p.written).toBe(false);
    expect(
      p.changes.some((c) =>
        c.now?.includes("harbor.audit.events # publishes, declared by pat on 2026-11-06"),
      ),
    ).toBe(true);
    const file = join(root, "org-pack/profiles/forge/profile.yaml");
    expect(await readFile(file, "utf8")).toBe(PROFILE);
    await declareLink(root, d, { by: "pat", at });
    const text = await readFile(file, "utf8");
    expect(text).toContain("# The Forge profile (invented).");
    expect(text).toContain("schemaVersion: 2");
    expect(
      (parse(text) as { systems: { id: string; topics?: string[] }[] }).systems[1]!.topics,
    ).toEqual(["harbor.audit.events"]);
    expect((await declaredOf(root, "harbor-audit")).list).toEqual([
      {
        kind: "topic",
        system: "harbor-audit",
        value: "harbor.audit.events",
        side: "publishes",
        by: "pat",
        at: "2026-11-06",
      },
    ]);
    await expect(declareLink(root, d, { by: "pat", at })).rejects.toBeInstanceOf(DeclareError);
  });

  it("writes a call a system makes to a route, and undoes exactly it", async () => {
    const root = await metarepo();
    await declareLink(
      root,
      { kind: "call", system: "northwind-pay", route: "POST /partners/northwind/webhooks" },
      { by: "pat", at },
    );
    expect((await declaredOf(root, "northwind-pay")).list).toEqual([
      {
        kind: "call",
        system: "northwind-pay",
        value: "POST /partners/northwind/webhooks",
        by: "pat",
        at: "2026-11-06",
      },
    ]);
    const u = await undeclareLink(root, {
      kind: "call",
      system: "northwind-pay",
      value: "POST /partners/northwind/webhooks",
    });
    expect(u.changes.length).toBeGreaterThan(0);
    expect((await declaredOf(root, "northwind-pay")).list).toEqual([]);
    await expect(
      undeclareLink(root, {
        kind: "call",
        system: "northwind-pay",
        value: "POST /partners/northwind/webhooks",
      }),
    ).rejects.toBeInstanceOf(DeclareError);
    await expect(
      declareLink(root, { kind: "call", system: "nowhere", route: "GET /x" }, { by: "pat", at }),
    ).rejects.toBeInstanceOf(DeclareError);
  });
});

describe("the preview's line diff", () => {
  it("pairs what changed, and leaves out what didn't", async () => {
    const { changedLines } = await import("../src/index.js");
    expect(changedLines("a\nb\nc\nd\n", "a\nB\nc\nd\ne\n")).toEqual([
      { was: "b", now: "B" },
      { now: "e" },
    ]);
    expect(changedLines("x\n", "x\n")).toEqual([]);
  });
});
