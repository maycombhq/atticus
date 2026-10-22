import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrgPack } from "@maycombhq/core";
import { MockRuntime, type AiRequest } from "@maycombhq/ai";
import {
  findKnowledge,
  keepCandidate,
  readFind,
  readFinds,
  readKnowledge,
  readSnapshot,
  saveFind,
  scanKnowledge,
  searchPages,
  syncSources,
  writeKnowledge,
  writeSnapshots,
} from "../src/index.js";

/**
 * ADR 0101: a developer searches every wiki for a term or phrase; the assistant reads the pages
 * that mention it and proposes what they hold that isn't a knowledge item yet, each quote
 * checked; the developer keeps what they want, as the kind they choose.
 */

const RELEASE = `# Releasing a service

## Getting a production change approved

To release to production, raise a normal change in the service desk at least 3 working days before. Attach the test evidence and the rollback plan. The change advisory board meets on Tuesdays.

## Freeze

No releases between 20 December and 3 January.
`;
const OTHER = `# Logging

## Format

Log as JSON.
`;

async function metarepo() {
  const base = await mkdtemp(join(tmpdir(), "atticus-find-"));
  await mkdir(join(base, "wiki"), { recursive: true });
  await writeFile(join(base, "wiki", "release.md"), RELEASE);
  await writeFile(join(base, "wiki", "logging.md"), OTHER);
  const root = join(base, "meta");
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack", "sources.yaml"),
    `schemaVersion: 1\nwikis:\n  - { id: eng, type: markdown-folder, location: ${JSON.stringify(join(base, "wiki").split("\\").join("/"))} }\n`,
  );
  const op = await loadOrgPack(join(root, "org-pack"));
  const now = "2026-10-20T09:00:00Z";
  const s = await syncSources({ root, orgPack: op, orgPackDir: join(root, "org-pack"), now });
  await writeSnapshots({ root, orgPack: op, sync: s, takenAt: now });
  const snap = (await readSnapshot(root, "eng"))!;
  // The first scan already read the freeze.
  const first = await scanKnowledge([snap], {
    runtime: new MockRuntime(
      () => `items:
  - kind: constraint
    id: holiday-freeze
    title: Holiday release freeze
    applies_when: A release between 20 December and 3 January.
    source: { page: release.md, section: Freeze, quote: "No releases between 20 December and 3 January." }
`,
    ),
    now: new Date(now),
  });
  await writeKnowledge(root, first, now, { snapshots: [snap] });
  return { root, snap };
}

const FOUND = `items:
  - kind: process
    id: production-change
    title: Get a production change approved
    applies_when: A release to production.
    steps: [Raise a normal change at least 3 working days before, Attach the test evidence and the rollback plan, The change advisory board decides on Tuesday]
    lead_time: 3 working days
    source: { page: release.md, section: Getting a production change approved, quote: "To release to production, raise a normal change in the service desk at least 3 working days before." }
  - kind: constraint
    id: holiday-freeze
    title: Holiday release freeze
    applies_when: A release between 20 December and 3 January.
    source: { page: release.md, section: Freeze, quote: "No releases between 20 December and 3 January." }
`;

describe("searching the wikis", () => {
  it("finds the pages and sections that mention a phrase, without the AI", async () => {
    const { snap } = await metarepo();
    expect(searchPages([snap], "production change")).toEqual([
      {
        source: "eng",
        page: "release.md",
        section: "Getting a production change approved",
        line: 3,
        excerpt: "## Getting a production change approved",
      },
    ]);
    // Every word of the phrase in one section counts too.
    expect(searchPages([snap], "rollback evidence").map((m) => m.section)).toEqual([
      "Getting a production change approved",
    ]);
    expect(searchPages([snap], "kubernetes")).toEqual([]);
  });

  it("has the assistant read only those pages and propose what isn't known yet, checked", async () => {
    const { root, snap } = await metarepo();
    const known = (await readKnowledge(root)).items;
    let prompt = "";
    const r = await findKnowledge([snap], "production change", {
      runtime: new MockRuntime((q: AiRequest) => {
        prompt = q.pack.prompt;
        return FOUND;
      }),
      items: known,
      now: new Date("2026-10-22T09:00:00Z"),
    });
    expect(r.status).toBe("found");
    expect(prompt).toContain('searched the wikis for "production change"');
    expect(prompt).toContain("holiday-freeze");
    expect(prompt).not.toContain("Log as JSON");
    expect(r.candidates.map((c) => [c.record.id, c.known ?? null])).toEqual([
      ["holiday-freeze", "holiday-freeze"],
      ["production-change", null],
    ]);
    const slug = await saveFind(root, r, "2026-10-22T09:00:00Z");
    expect(slug).toBe("production-change");
    expect((await readFinds(root)).map((f) => [f.slug, f.phrase, f.candidates, f.kept])).toEqual([
      ["production-change", "production change", 2, 0],
    ]);
  });

  it("says when no page mentions it, and asks nothing", async () => {
    const { root, snap } = await metarepo();
    const r = await findKnowledge([snap], "kubernetes", {
      runtime: new MockRuntime(() => {
        throw new Error("nothing to ask");
      }),
      items: (await readKnowledge(root)).items,
    });
    expect(r).toMatchObject({ status: "nothing", candidates: [], matches: [] });
  });

  it("keeps a candidate as the kind the person chooses, verified by them", async () => {
    const { root, snap } = await metarepo();
    const r = await findKnowledge([snap], "production change", {
      runtime: new MockRuntime(() => FOUND),
      items: (await readKnowledge(root)).items,
      now: new Date("2026-10-22T09:00:00Z"),
    });
    const slug = await saveFind(root, r, "2026-10-22T09:00:00Z");
    const kept = await keepCandidate(root, slug, "production-change", {
      as: "request",
      by: "Tom George",
      at: "2026-10-22T10:00:00Z",
      set: { catalogueItem: "Normal change" },
    });
    if ("error" in kept) throw new Error(kept.error);
    const k = await readKnowledge(root);
    expect(k.items.find((i) => i.id === "production-change")).toMatchObject({
      kind: "ProcessDefinition",
      processKind: "request",
      catalogueItem: "Normal change",
      flags: ["found:production-change"],
    });
    expect(k.reviews["production-change"]).toMatchObject({ state: "corrected", by: "Tom George" });
    expect(
      (await readFind(root, slug))!.candidates.find((c) => c.record.id === "production-change")!
        .kept,
    ).toMatchObject({
      by: "Tom George",
      as: "request",
    });
    expect(
      await keepCandidate(root, slug, "production-change", {
        as: "team",
        by: "T",
        at: "2026-10-22T10:00:00Z",
      }),
    ).toMatchObject({
      error: expect.stringContaining("can be kept as process or request"),
    });
  });

  it("survives a rescan of its page while its quote is still there", async () => {
    const { root, snap } = await metarepo();
    const r = await findKnowledge([snap], "production change", {
      runtime: new MockRuntime(() => FOUND),
      items: (await readKnowledge(root)).items,
      now: new Date("2026-10-22T09:00:00Z"),
    });
    const slug = await saveFind(root, r, "2026-10-22T09:00:00Z");
    await keepCandidate(root, slug, "production-change", { by: "T", at: "2026-10-22T10:00:00Z" });
    // A full rescan of the page whose answer doesn't have it.
    const again = await scanKnowledge([snap], {
      runtime: new MockRuntime(
        () => `items:
  - kind: constraint
    id: holiday-freeze
    title: Holiday release freeze
    applies_when: A release between 20 December and 3 January.
    source: { page: release.md, section: Freeze, quote: "No releases between 20 December and 3 January." }
`,
      ),
      now: new Date("2026-10-23T09:00:00Z"),
    });
    const w = await writeKnowledge(root, again, "2026-10-23T09:00:00Z", { snapshots: [snap] });
    expect(w.changes.removed).toEqual([]);
    expect((await readKnowledge(root)).items.map((i) => i.id).sort()).toEqual([
      "holiday-freeze",
      "production-change",
    ]);
  });
});
