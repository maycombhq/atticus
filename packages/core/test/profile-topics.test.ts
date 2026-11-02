import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  addProfileSystem,
  migrateProfileText,
  Profile,
  PROFILE_SCHEMA_VERSION,
} from "../src/index.js";

/**
 * ADR 0162 amendment (review item 15): a profile system's `topics`, the topics and queues it owns,
 * kept apart from its `aliases` (names people and hosts use), so a dotted topic never reads as a
 * host or a vendor's name. Profile schema version 2; a version-1 profile parses as it is.
 */

const ESTATE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/link-estate");
const PROFILE = ["org-pack", "profiles", "forge", "profile.yaml"];

const v = (schemaVersion: number, systems: object[]) => ({
  schemaVersion,
  platform: "forge",
  name: "Forge",
  systems,
});
const sys = (id: string, more: object = {}) => ({
  id,
  name: id,
  boundary: "internal",
  ...more,
});

describe("Profile topics (ADR 0162 amendment)", () => {
  it("is version 2", () => expect(PROFILE_SCHEMA_VERSION).toBe(2));

  it("reads a version-1 profile as it is, with no topics", () => {
    const p = Profile.parse(v(1, [sys("harbor-audit", { aliases: ["Harbor"] })]));
    expect(p.schemaVersion).toBe(1);
    expect(p.systems[0]).not.toHaveProperty("topics");
    expect(p.systems[0]!.aliases).toEqual(["Harbor"]);
  });

  it("takes topics at version 2, and asks for version 2 to name them", () => {
    const p = Profile.parse(v(2, [sys("harbor-audit", { topics: ["harbor.audit.events"] })]));
    expect(p.systems[0]!.topics).toEqual(["harbor.audit.events"]);
    const old = Profile.safeParse(v(1, [sys("harbor-audit", { topics: ["harbor.audit.events"] })]));
    expect(old.success).toBe(false);
    expect(JSON.stringify(old.error?.issues)).toContain("topics needs schemaVersion 2");
  });

  it("refuses a topic two systems own", () => {
    const r = Profile.safeParse(
      v(2, [
        sys("harbor-audit", { topics: ["audit.events"] }),
        sys("ledger-ops", { topics: ["audit.events"] }),
      ]),
    );
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(
      '\\"audit.events\\" is already owned by harbor-audit',
    );
  });

  it("moves a version-1 file to 2, changing only the number", () => {
    const v1 = "# Forge\nschemaVersion: 1 # was 1\nplatform: forge\nname: Forge\n";
    expect(migrateProfileText(v1)).toEqual({
      text: "# Forge\nschemaVersion: 2 # was 1\nplatform: forge\nname: Forge\n",
      changed: true,
    });
    expect(migrateProfileText("schemaVersion: 2\nplatform: forge\nname: Forge\n").changed).toBe(
      false,
    );
  });
});

describe("addProfileSystem writes a topic under topics (ADR 0162 amendment)", () => {
  async function metarepo() {
    const root = await mkdtemp(join(tmpdir(), "atticus-profile-topics-"));
    await cp(join(ESTATE, "org-pack"), join(root, "org-pack"), { recursive: true });
    return root;
  }
  const systems = async (root: string) =>
    parse(await readFile(join(root, ...PROFILE), "utf8")) as {
      schemaVersion: number;
      systems: { id: string; aliases?: string[]; topics?: string[] }[];
    };

  it("puts the topic under an existing system's topics, never its aliases, at version 2", async () => {
    const root = await metarepo();
    const r = await addProfileSystem(root, "forge-cards", {
      id: "harbor-audit",
      name: "Harbor Audit",
      boundary: "internal",
      topics: ["harbor.audit.events"],
    });
    expect(r).toMatchObject({ id: "harbor-audit", added: false, topics: ["harbor.audit.events"] });
    const p = await systems(root);
    expect(p.schemaVersion).toBe(2);
    const s = p.systems.find((x) => x.id === "harbor-audit")!;
    expect(s.topics).toEqual(["harbor.audit.events"]);
    expect(s.aliases).toEqual([]);
    const text = await readFile(join(root, ...PROFILE), "utf8");
    expect(text).toContain("# Invented vendors, each named by the host the code calls it on.");
    // Again: nothing more to write.
    const again = await addProfileSystem(root, "forge-cards", {
      id: "harbor-audit",
      name: "Harbor Audit",
      boundary: "internal",
      topics: ["harbor.audit.events"],
    });
    expect(again).not.toHaveProperty("topics");
  });

  it("adds a new system with the topic under its topics", async () => {
    const root = await metarepo();
    const r = await addProfileSystem(root, "forge-cards", {
      id: "team-ledger-ops-system",
      name: "Ledger Ops's system",
      boundary: "internal",
      owner: "team-ledger-ops",
      topics: ["ledger.ops.events"],
    });
    expect(r.added).toBe(true);
    const p = await systems(root);
    expect(p.schemaVersion).toBe(2);
    expect(p.systems.find((x) => x.id === "team-ledger-ops-system")).toMatchObject({
      aliases: [],
      topics: ["ledger.ops.events"],
    });
  });
});
