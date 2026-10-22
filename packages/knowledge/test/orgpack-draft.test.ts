import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Profile, parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import {
  acceptOrgPackDraft,
  draftOrgPack,
  readKnowledge,
  reviewItem,
  writeReview,
} from "../src/index.js";

/**
 * ADR 0101: the org pack drafted from what the wikis say. Nobody knows every system, alias and
 * vendor of a big organisation on day one; the knowledge scan reads them from the pages, and
 * the draft proposes them as the profile's systems, for a person to accept into the org pack.
 */

const q = (section: string, text: string) => ({
  source: "eng",
  page: "teams.md",
  section,
  text,
  snapshot: "2026-10-20",
});
const rec = (r: Record<string, unknown>) => {
  const p = parseRecord({
    schemaVersion: 2,
    status: "current",
    confidence: "inferred",
    evidence: [{ source: "document", path: "knowledge/snapshots/eng/2026-10-20/teams.md" }],
    ...r,
  });
  if (!p.ok) throw new Error(JSON.stringify(p.issues));
  return p.record;
};

const ITEMS = [
  // A product the profile doesn't have yet, with the names people use for it.
  rec({
    kind: "Product",
    id: "chat-history",
    name: "Chat history service",
    productKind: "product",
    ownedBy: "Messaging team",
    aliases: ["CHS", "history-api"],
    quote: q("Messaging team", "The Messaging team owns the Chat history service (CHS)."),
  }),
  // A product the profile has under another name: it gains its new alias and its owner.
  rec({
    kind: "Product",
    id: "ledger-service",
    name: "Ledger",
    productKind: "product",
    ownedBy: "Ledger team",
    aliases: ["the books", "LDG"],
    quote: q("Ledger team", "The Ledger team owns the ledger, which people call the books."),
  }),
  // A vendor: an outside system.
  rec({
    kind: "Party",
    id: "northwind-pay",
    name: "Northwind Pay",
    partyKind: "vendor",
    owner: "Payments team",
    aliases: ["NWP"],
    quote: q("Vendors", "Northwind Pay is the card processor."),
  }),
  // A vendor whose alias is already another system's name: the alias is left out, and said.
  rec({
    kind: "Party",
    id: "harbour",
    name: "Harbour MFT",
    partyKind: "vendor",
    aliases: ["CHS"],
    quote: q("Vendors", "Files go through Harbour MFT."),
  }),
  // A project and a team are knowledge, not systems.
  rec({
    kind: "Product",
    id: "month-end",
    name: "Month-end close",
    productKind: "project",
    quote: q("Ledger team", "The month-end close project."),
  }),
];

async function metarepo() {
  const root = await mkdtemp(join(tmpdir(), "atticus-orgpack-draft-"));
  await mkdir(join(root, "org-pack", "profiles", "forge"), { recursive: true });
  await writeFile(join(root, "org-pack", "sources.yaml"), "schemaVersion: 1\n");
  await writeFile(
    join(root, "org-pack", "profiles", "forge", "profile.yaml"),
    "# The Forge platform.\nschemaVersion: 1\nplatform: forge\nname: Forge\nsystems:\n  - id: ledger\n    name: Ledger\n    boundary: product\n    aliases: [LDG]\n",
  );
  for (const r of ITEMS) {
    const f = join(root, "knowledge", "items", ...recordPath(r).split("/"));
    await mkdir(join(f, ".."), { recursive: true });
    await writeFile(f, serializeRecord(r));
  }
  return root;
}

describe("the org pack, drafted from the knowledge", () => {
  it("proposes the systems the pages name, with their aliases and owners, citing each", async () => {
    const root = await metarepo();
    const item = (await readKnowledge(root)).items.find((i) => i.id === "northwind-pay")!;
    const v = reviewItem(item, {
      verdict: "verified",
      by: "Tom George",
      at: "2026-10-21T09:00:00Z",
    });
    if ("error" in v) throw new Error(v.error);
    await writeReview(root, v.review);

    const d = await draftOrgPack(root, {});
    expect(d.platform).toBe("forge");
    expect(d.proposals.map((p) => [p.from, p.action, p.system.id, p.verified])).toEqual([
      ["chat-history", "add", "chat-history", false],
      ["harbour", "add", "harbour", false],
      ["ledger-service", "update", "ledger", false],
      ["northwind-pay", "add", "northwind-pay", true],
    ]);
    const byFrom = new Map(d.proposals.map((p) => [p.from, p]));
    expect(byFrom.get("chat-history")!.system).toEqual({
      id: "chat-history",
      name: "Chat history service",
      boundary: "internal",
      owner: "Messaging team",
      aliases: ["CHS", "history-api"],
      tags: [],
    });
    expect(byFrom.get("northwind-pay")!.system).toMatchObject({
      boundary: "vendor",
      owner: "Payments team",
      aliases: ["NWP"],
    });
    expect(byFrom.get("ledger-service")!).toMatchObject({
      adds: { aliases: ["the books"], owner: "Ledger team" },
    });
    expect(byFrom.get("harbour")!.notes).toEqual([
      '"CHS" already names chat-history, so it was left out',
    ]);
    expect(byFrom.get("chat-history")!.quote).toBe(
      "The Messaging team owns the Chat history service (CHS).",
    );
    expect(readFileSync(join(root, d.file), "utf8")).toContain("chat-history");
    expect(readFileSync(join(root, d.file.replace(/\.yaml$/, ".md")), "utf8")).toMatch(
      /Northwind Pay.*✓ verified by Tom George/,
    );
  });

  it("accepts what a person picks into profile.yaml, keeping its comments and its rules", async () => {
    const root = await metarepo();
    await draftOrgPack(root, {});
    const dry = await acceptOrgPackDraft(root, "forge", { dryRun: true });
    expect(dry).toMatchObject({
      added: ["chat-history", "harbour", "northwind-pay"],
      updated: ["ledger"],
    });
    const a = await acceptOrgPackDraft(root, "forge", { only: ["chat-history", "ledger-service"] });
    expect(a).toMatchObject({ added: ["chat-history"], updated: ["ledger"] });
    const text = readFileSync(join(root, "org-pack", "profiles", "forge", "profile.yaml"), "utf8");
    expect(text).toContain("# The Forge platform.");
    const p = Profile.parse(parse(text));
    expect(p.systems.map((s) => [s.id, s.aliases, s.owner ?? null])).toEqual([
      ["ledger", ["LDG", "the books"], "Ledger team"],
      ["chat-history", ["CHS", "history-api"], "Messaging team"],
    ]);
    // What was accepted leaves the draft; the rest waits.
    const again = await draftOrgPack(root, {});
    expect(again.proposals.map((x) => x.from)).toEqual(["harbour", "northwind-pay"]);
  });

  it("accepts only what a person verified, when asked", async () => {
    const root = await metarepo();
    await draftOrgPack(root, {});
    const a = await acceptOrgPackDraft(root, "forge", { verifiedOnly: true, dryRun: true });
    expect(a).toMatchObject({ added: [], updated: [] });
  });
});
