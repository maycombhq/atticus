import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrgPack } from "@maycombhq/core";
import { MockRuntime } from "@maycombhq/ai";
import {
  planRescan,
  readKnowledge,
  readSnapshot,
  scanKnowledge,
  syncSources,
  writeKnowledge,
  writeSnapshots,
  type KnowledgeScanResult,
} from "../src/index.js";

/**
 * Review round 50: a rescan merges what it read again with what it kept. An also_on quote is
 * checked again when its page changes, an id another page's item has is refused and handed back,
 * a conflict with a page not read again stays, and a page superseded by one that didn't change
 * is still superseded. Invented Forge pages; the mock runtime answers.
 */

async function estate(sources: string[] = ["w"]) {
  const base = await mkdtemp(join(tmpdir(), "atticus-rescan-merge-"));
  const root = join(base, "root");
  await mkdir(join(root, "org-pack"), { recursive: true });
  const wikis: Record<string, string> = {};
  for (const s of sources) {
    wikis[s] = join(base, s);
    await mkdir(wikis[s]!, { recursive: true });
  }
  await writeFile(
    join(root, "org-pack/sources.yaml"),
    `schemaVersion: 1\nwikis:\n${sources
      .map(
        (s) => `  - { id: ${s}, type: markdown-folder, location: ${JSON.stringify(wikis[s])} }\n`,
      )
      .join("")}`,
  );
  let day = 1;
  /** Sync, plan, scan with the mock's answer, write, as `atticus knowledge scan` does. */
  async function scan(answer: string, o: { source?: string } = {}) {
    const op = await loadOrgPack(join(root, "org-pack"));
    const takenAt = `2026-11-${String(day++).padStart(2, "0")}T09:00:00Z`;
    const s = await syncSources({
      root,
      orgPack: op,
      orgPackDir: join(root, "org-pack"),
      now: takenAt,
    });
    await writeSnapshots({ root, orgPack: op, sync: s, takenAt });
    const snaps = [];
    for (const id of o.source ? [o.source] : sources) snaps.push((await readSnapshot(root, id))!);
    const before = await readKnowledge(root, { raw: true });
    const plan = planRescan(snaps, before.report, before.items);
    const previous = new Set(plan.previous);
    let r: KnowledgeScanResult = {
      status: "scanned",
      attempts: [],
      items: [],
      conflicts: [],
      superseded: [],
      injections: [],
      failed: [],
      snapshots: [],
    };
    if (plan.snapshots.length)
      r = await scanKnowledge(plan.snapshots, {
        runtime: new MockRuntime(() => answer),
        orgPack: op,
        now: new Date(takenAt),
        maxAttempts: 1,
        ...(plan.previous.length ? { previous: plan.previous } : {}),
        taken: before.items.filter((i) => !previous.has(i)),
      });
    const w = await writeKnowledge(root, r, takenAt, { snapshots: snaps, plan });
    return { r, w, k: await readKnowledge(root, { raw: true }) };
  }
  return { base, root, wikis, scan };
}

const A =
  "# Retries\n\n## Policy\n\nPayment calls to Northwind Pay are retried at most twice with backoff.\n";
const B =
  "# Gateway guide\n\n## Retries\n\nPayment calls to Northwind Pay are retried at most twice with backoff, as the retry policy says.\n";
const C =
  "# Vendors\n\n## Northwind\n\nNorthwind Pay onboarding takes ten working days from the request.\n";
const D =
  "# Onboarding\n\n## Northwind\n\nNorthwind Pay onboarding takes five working days from the request.\n";

const RETRIES = `  - kind: standard
    id: payment-retries
    title: Payment retries
    applies_when: A service calls Northwind Pay.
    rules: ["Retry at most twice with backoff."]
    source: { page: a.md, section: Policy, quote: "Payment calls to Northwind Pay are retried at most twice with backoff." }
    also_on:
      - { page: b.md, section: Retries, quote: "Payment calls to Northwind Pay are retried at most twice with backoff, as the retry policy says." }
`;
const onboarding = (id: string, page: string, lead: string) => `  - kind: process
    id: ${id}
    title: Northwind onboarding
    applies_when: A service will call Northwind Pay for the first time.
    lead_time: ${lead} working days
    source: { page: ${page}, section: Northwind, quote: "Northwind Pay onboarding takes ${lead} working days from the request." }
`;

describe("an also_on quote is checked again when its page changes", () => {
  it("drops the also_on quote no longer on its edited page and keeps the item", async () => {
    const e = await estate();
    await writeFile(join(e.wikis.w!, "a.md"), A);
    await writeFile(join(e.wikis.w!, "b.md"), B);
    let { k } = await e.scan(`items:\n${RETRIES}`);
    expect(k.items[0]!.alsoOn.map((a) => a.page)).toEqual(["b.md"]);
    await writeFile(
      join(e.wikis.w!, "b.md"),
      "# Gateway guide\n\n## Retries\n\nPayment calls to Northwind Pay are never retried by the caller.\n",
    );
    const second = await e.scan("items: []\n");
    k = second.k;
    expect(k.items.map((i) => i.id)).toEqual(["payment-retries"]);
    expect(k.items[0]!.alsoOn).toEqual([]);
    expect(k.items[0]!.evidence.map((x) => x.path)).not.toContainEqual(
      expect.stringContaining("b.md"),
    );
    expect(second.w.changes.changed).toEqual(["payment-retries"]);
  });

  it("keeps an also_on quote still on its edited page, and drops one whose page is gone", async () => {
    const e = await estate();
    await writeFile(join(e.wikis.w!, "a.md"), A);
    await writeFile(join(e.wikis.w!, "b.md"), B);
    await e.scan(`items:\n${RETRIES}`);
    await writeFile(join(e.wikis.w!, "b.md"), `${B}\nAsk the gateway team first.\n`);
    let { k } = await e.scan("items: []\n");
    expect(k.items[0]!.alsoOn.map((a) => a.page)).toEqual(["b.md"]);
    await rm(join(e.wikis.w!, "b.md"));
    ({ k } = await e.scan("items: []\n"));
    expect(k.items.map((i) => i.id)).toEqual(["payment-retries"]);
    expect(k.items[0]!.alsoOn).toEqual([]);
  });
});

describe("an id another page's item has is refused", () => {
  it("hands an id reused on a changed page back to the AI and keeps the first page's item", async () => {
    const e = await estate();
    await writeFile(join(e.wikis.w!, "a.md"), A);
    await writeFile(join(e.wikis.w!, "c.md"), C);
    await e.scan(
      `items:\n${RETRIES.split("    also_on:")[0]}${onboarding("vendor-onboarding", "c.md", "ten")}`,
    );
    await writeFile(
      join(e.wikis.w!, "c.md"),
      `${C}\nRetry the onboarding request once if it bounces.\n`,
    );
    const { r, k } = await e.scan(`items:
  - kind: standard
    id: payment-retries
    title: Onboarding retries
    applies_when: An onboarding request bounces.
    rules: ["Retry once."]
    source: { page: c.md, section: Northwind, quote: "Retry the onboarding request once if it bounces." }
${onboarding("vendor-onboarding", "c.md", "ten")}`);
    expect(r.failed).toContainEqual(
      expect.objectContaining({
        id: "payment-retries",
        problems: ["id payment-retries is used by a.md; choose another"],
      }),
    );
    expect(r.attempts.at(-1)!.problems).toContain(
      "standard payment-retries: id payment-retries is used by a.md; choose another",
    );
    const kept = k.items.find((i) => i.id === "payment-retries")!;
    expect(kept.quote!.page).toBe("a.md");
    expect(kept.kind === "Pattern" && kept.name).toBe("Payment retries");
  });

  it("refuses an id another source's item has, scanning one source", async () => {
    const e = await estate(["w", "team"]);
    await writeFile(join(e.wikis.w!, "a.md"), A);
    await writeFile(join(e.wikis.team!, "c.md"), C);
    await e.scan(`items:\n${RETRIES.split("    also_on:")[0]}`, { source: "w" });
    const { r, k } = await e.scan(`items:\n${onboarding("payment-retries", "c.md", "ten")}`, {
      source: "team",
    });
    expect(r.failed.map((f) => f.problems)).toContainEqual([
      "id payment-retries is used by w/a.md; choose another",
    ]);
    expect(k.items.map((i) => `${i.id}@${i.quote!.source}/${i.quote!.page}`)).toEqual([
      "payment-retries@w/a.md",
    ]);
  });

  it("never writes a result item over a kept item of another page, and says so", async () => {
    const e = await estate();
    await writeFile(join(e.wikis.w!, "a.md"), A);
    await writeFile(join(e.wikis.w!, "c.md"), C);
    await e.scan(
      `items:\n${RETRIES.split("    also_on:")[0]}${onboarding("vendor-onboarding", "c.md", "ten")}`,
    );
    // A scan of c.md alone (as an older caller would run it, nothing taken) reusing a.md's id.
    const op = await loadOrgPack(join(e.root, "org-pack"));
    const snap = (await readSnapshot(e.root, "w"))!;
    await writeFile(
      join(e.wikis.w!, "c.md"),
      `${C}\nRetry the onboarding request once if it bounces.\n`,
    );
    const s = await syncSources({ root: e.root, orgPack: op, now: "2026-11-20T09:00:00Z" });
    await writeSnapshots({ root: e.root, orgPack: op, sync: s, takenAt: "2026-11-20T09:00:00Z" });
    const now = (await readSnapshot(e.root, "w"))!;
    const before = await readKnowledge(e.root, { raw: true });
    const plan = planRescan([now], before.report, before.items);
    expect(snap.manifest.date).not.toBe(now.manifest.date);
    const r = await scanKnowledge(plan.snapshots, {
      runtime: new MockRuntime(
        () => `items:
  - kind: process
    id: payment-retries
    title: Onboarding retries
    applies_when: An onboarding request bounces.
    source: { page: c.md, section: Northwind, quote: "Retry the onboarding request once if it bounces." }
`,
      ),
      now: new Date("2026-11-20T09:00:00Z"),
      maxAttempts: 1,
    });
    expect(r.items.map((i) => i.id)).toEqual(["payment-retries"]);
    const w = await writeKnowledge(e.root, r, "2026-11-20T09:00:00Z", { snapshots: [now], plan });
    const k = await readKnowledge(e.root, { raw: true });
    expect(k.items.map((i) => `${i.kind}:${i.id}@${i.quote!.page}`)).toEqual([
      "Pattern:payment-retries@a.md",
    ]);
    expect(k.report!.failed).toContainEqual(
      expect.objectContaining({
        id: "payment-retries",
        page: "c.md",
        problems: ["id payment-retries is used by a.md; choose another"],
      }),
    );
    expect(w.changes.removed).toEqual(["vendor-onboarding"]);
  });
});

describe("a conflict with a page not read again stays", () => {
  it("keeps the conflict and both flags when one page is edited and still disagrees", async () => {
    const e = await estate();
    await writeFile(join(e.wikis.w!, "c.md"), C);
    await writeFile(join(e.wikis.w!, "d.md"), D);
    const one = onboarding("onboarding-c", "c.md", "ten");
    const two = onboarding("onboarding-d", "d.md", "five");
    let { k } = await e.scan(`items:\n${one}${two}`);
    expect(k.report!.conflicts.map((c) => c.about)).toEqual([["onboarding-c", "onboarding-d"]]);
    await writeFile(join(e.wikis.w!, "c.md"), `${C}\nAsk in the vendor channel first.\n`);
    ({ k } = await e.scan(`items:\n${one}`));
    expect(k.report!.conflicts.map((c) => [...c.about].sort())).toEqual([
      ["onboarding-c", "onboarding-d"],
    ]);
    for (const i of k.items) expect(i.flags).toEqual(["conflict:c.md|d.md"]);
  });

  it("finds a conflict between an item read now and one kept from an earlier scan", async () => {
    const e = await estate();
    await writeFile(join(e.wikis.w!, "c.md"), C);
    let { k } = await e.scan(`items:\n${onboarding("onboarding-c", "c.md", "ten")}`);
    expect(k.report!.conflicts).toEqual([]);
    await writeFile(join(e.wikis.w!, "d.md"), D);
    ({ k } = await e.scan(`items:\n${onboarding("onboarding-d", "d.md", "five")}`));
    expect(k.report!.conflicts).toHaveLength(1);
    expect(k.report!.conflicts[0]).toMatchObject({
      foundBy: "check",
      pages: [
        { source: "w", page: "d.md" },
        { source: "w", page: "c.md" },
      ],
      says: [
        "Northwind Pay onboarding takes five working days from the request.",
        "Northwind Pay onboarding takes ten working days from the request.",
      ],
    });
    for (const i of k.items) expect(i.flags).toEqual(["conflict:d.md|c.md"]);
  });

  it("drops the conflict and its flags once the edited page agrees, or an item is gone", async () => {
    const e = await estate();
    await writeFile(join(e.wikis.w!, "c.md"), C);
    await writeFile(join(e.wikis.w!, "d.md"), D);
    const two = onboarding("onboarding-d", "d.md", "five");
    await e.scan(`items:\n${onboarding("onboarding-c", "c.md", "ten")}${two}`);
    await writeFile(join(e.wikis.w!, "c.md"), C.replace("ten", "five"));
    let { k } = await e.scan(`items:\n${onboarding("onboarding-c", "c.md", "five")}`);
    expect(k.report!.conflicts).toEqual([]);
    for (const i of k.items) expect(i.flags ?? []).toEqual([]);
    // Disagree again, then the page goes: no conflict names an item that isn't there.
    await writeFile(join(e.wikis.w!, "c.md"), C);
    ({ k } = await e.scan(`items:\n${onboarding("onboarding-c", "c.md", "ten")}`));
    expect(k.report!.conflicts).toHaveLength(1);
    await rm(join(e.wikis.w!, "c.md"));
    ({ k } = await e.scan("items: []\n"));
    expect(k.items.map((i) => i.id)).toEqual(["onboarding-d"]);
    expect(k.report!.conflicts).toEqual([]);
    expect(k.items[0]!.flags ?? []).toEqual([]);
  });
});

describe("a page superseded by one that didn't change", () => {
  it("is superseded on a rescan of the old page alone, and its items are refused", async () => {
    const e = await estate();
    const O =
      "# Logging\n\n## Format\n\nEvery service writes plain text logs to a local file under /var/log.\n";
    await writeFile(join(e.wikis.w!, "old.md"), O);
    await writeFile(
      join(e.wikis.w!, "new.md"),
      "# Logging v2\n\n## Format\n\nEvery service writes JSON logs to standard output.\n",
    );
    const item = `items:
  - kind: standard
    id: log-to-file
    title: Log to a file
    applies_when: A service writes logs.
    rules: ["Write plain text logs to /var/log."]
    source: { page: old.md, section: Format, quote: "Every service writes plain text logs to a local file under /var/log." }
`;
    await e.scan(item);
    await writeFile(join(e.wikis.w!, "old.md"), `---\nsuperseded-by: new.md\n---\n${O}`);
    const { r, k } = await e.scan(item);
    expect(k.report!.superseded).toEqual([
      expect.objectContaining({
        old: { source: "w", page: "old.md" },
        new: { source: "w", page: "new.md" },
      }),
    ]);
    expect(k.items).toEqual([]);
    expect(r.failed[0]!.problems[0]).toMatch(/old\.md is superseded by new\.md/);
  });

  it("takes the AI's superseded page when the newer page wasn't read again", async () => {
    const e = await estate();
    const O =
      "# Logging\n\n## Format\n\nEvery service writes plain text logs to a local file under /var/log.\n";
    await writeFile(join(e.wikis.w!, "old.md"), O);
    await writeFile(
      join(e.wikis.w!, "new.md"),
      "# Logging v2\n\n## Format\n\nEvery service writes JSON logs to standard output.\n",
    );
    await e.scan("items: []\n");
    await writeFile(
      join(e.wikis.w!, "old.md"),
      `${O}\nThis page is replaced by the Logging v2 page.\n`,
    );
    const { k } = await e.scan(`items: []
superseded:
  - { old: old.md, new: new.md, quote: "This page is replaced by the Logging v2 page." }
`);
    expect(k.report!.superseded).toEqual([
      expect.objectContaining({
        new: { source: "w", page: "new.md" },
        quotedOn: { source: "w", page: "old.md" },
      }),
    ]);
  });
});
