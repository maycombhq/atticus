import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { init } from "@maycombhq/adopt";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { orgPackDraftCli } from "../src/orgpack-draft-commands.js";

/** ADR 0101: atticus orgpack draft and accept. */

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

async function metarepo() {
  const root = join(await mkdtemp(join(tmpdir(), "atticus-orgpack-cli-")), "forge-meta");
  await init(root, { name: "forge", platform: "forge", openspec: "folders" });
  const p = parseRecord({
    schemaVersion: 2,
    kind: "Product",
    id: "chat-history",
    status: "current",
    confidence: "inferred",
    evidence: [{ source: "document", path: "knowledge/snapshots/eng/2026-10-20/teams.md" }],
    name: "Chat history service",
    productKind: "product",
    ownedBy: "Messaging team",
    aliases: ["CHS"],
    quote: {
      source: "eng",
      page: "teams.md",
      section: "Messaging",
      text: "The Messaging team owns the Chat history service (CHS).",
      snapshot: "2026-10-20",
    },
  });
  if (!p.ok) throw new Error(JSON.stringify(p.issues));
  const f = join(root, "knowledge", "items", ...recordPath(p.record).split("/"));
  await mkdir(join(f, ".."), { recursive: true });
  await writeFile(f, serializeRecord(p.record));
  return root;
}

describe("atticus orgpack draft and accept", () => {
  it("drafts the profile's systems from the knowledge, then puts them into profile.yaml", async () => {
    const root = await metarepo();
    const d = capture();
    expect(await orgPackDraftCli(root, "draft", undefined, {}, d.io)).toBe(0);
    expect(d.out[0]).toBe("1 system for the forge profile, from the knowledge items:");
    expect(d.out[1]).toBe("  add    chat-history: Chat history service (internal, Messaging team)");
    const a = capture();
    expect(await orgPackDraftCli(root, "accept", "forge", {}, a.io)).toBe(0);
    expect(a.out[0]).toBe(
      "Added chat-history and updated none in org-pack/profiles/forge/profile.yaml; 0 left in the draft.",
    );
    expect(
      readFileSync(join(root, "org-pack", "profiles", "forge", "profile.yaml"), "utf8"),
    ).toContain("Chat history service");
    const again = capture();
    await orgPackDraftCli(root, "draft", undefined, {}, again.io);
    expect(again.out).toEqual([
      "The forge profile already has every system the knowledge items name.",
    ]);
  });

  it("says when there is no draft to accept", async () => {
    const root = await metarepo();
    const c = capture();
    expect(await orgPackDraftCli(root, "accept", "forge", {}, c.io)).toBe(2);
    expect(c.err[0]).toMatch(/There is no draft for forge/);
  });
});
