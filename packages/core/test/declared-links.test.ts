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

describe("setting a repo's owner in a Windows checkout", () => {
  it("keeps the file's CRLF line endings, and previews only the line set", async () => {
    const { setManifestField } = await import("../src/index.js");
    const root = await mkdtemp(join(tmpdir(), "atticus-crlf-"));
    await mkdir(join(root, "org-pack/profiles/forge"), { recursive: true });
    const text = [
      "# The Forge repos (invented).",
      "schemaVersion: 2",
      "platform: forge",
      "repos:",
      "  - id: forge-ledger",
      "    url: https://git.example.com/forge/forge-ledger.git",
      "    type: spring-boot",
      "    owner: team-ledger",
      "",
    ].join("\r\n");
    const file = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
    await writeFile(file, text);
    const r = await setManifestField(root, "forge-ledger", "owner", "team-platform");
    expect(r.changes).toEqual([{ was: "    owner: team-ledger", now: "    owner: team-platform" }]);
    expect(await readFile(file, "utf8")).toBe(text.replace("team-ledger\r\n", "team-platform\r\n"));
  });
});

describe("two edits of one file at once", () => {
  it("never loses one: the second, made from the same version, is refused", async () => {
    const { setManifestField, FileChangedError } = await import("../src/index.js");
    const root = await mkdtemp(join(tmpdir(), "atticus-race-"));
    await mkdir(join(root, "org-pack/profiles/forge"), { recursive: true });
    const file = join(root, "org-pack/profiles/forge/repos.manifest.yaml");
    await writeFile(
      file,
      [
        "schemaVersion: 2",
        "platform: forge",
        "repos:",
        "  - { id: forge-ledger, url: https://git.example.com/forge/forge-ledger.git, type: spring-boot, owner: team-ledger }",
        "  - { id: forge-cards, url: https://git.example.com/forge/forge-cards.git, type: spring-boot, owner: team-cards }",
        "",
      ].join("\n"),
    );
    const both = await Promise.allSettled([
      setManifestField(root, "forge-ledger", "owner", "team-a"),
      setManifestField(root, "forge-cards", "owner", "team-b"),
    ]);
    const text = await readFile(file, "utf8");
    const done = both.filter((x) => x.status === "fulfilled").length;
    const refused = both.filter(
      (x) => x.status === "rejected" && x.reason instanceof FileChangedError,
    ).length;
    expect(done + refused).toBe(2);
    // Whatever was said written is in the file.
    if (both[0].status === "fulfilled") expect(text).toContain("owner: team-a");
    if (both[1].status === "fulfilled") expect(text).toContain("owner: team-b");
    // Done again from the file as it is now, it is written.
    await setManifestField(root, "forge-cards", "owner", "team-b");
    await setManifestField(root, "forge-ledger", "owner", "team-a");
    const after = await readFile(file, "utf8");
    expect(after).toContain("owner: team-a");
    expect(after).toContain("owner: team-b");
  });
});

describe("declaring in a Windows checkout", () => {
  it("previews only the lines it adds, and keeps CRLF", async () => {
    const root = await metarepo();
    const file = join(root, "org-pack/profiles/forge/profile.yaml");
    const crlf = PROFILE.replace(/\n/g, "\r\n");
    await writeFile(file, crlf);
    const r = await declareLink(
      root,
      { kind: "call", system: "northwind-pay", route: "POST /webhooks" },
      { by: "pat", at },
    );
    expect(r.changes.every((c) => c.was === undefined)).toBe(true);
    const after = await readFile(file, "utf8");
    expect(after.replace(/\r\n/g, "")).not.toContain("\n");
    expect(after.startsWith(crlf.split("    boundary: vendor")[0]!)).toBe(true);
  });
});
