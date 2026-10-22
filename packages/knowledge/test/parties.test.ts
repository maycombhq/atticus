import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { knowledgeKindOf, loadOrgPack } from "@maycombhq/core";
import { MockRuntime } from "@maycombhq/ai";
import {
  filterItems,
  itemTitle,
  readKnowledge,
  readSnapshot,
  reviewItem,
  scanKnowledge,
  syncSources,
  writeKnowledge,
  writeSnapshots,
} from "../src/index.js";

/** ADR 0101: the teams, vendors, products and projects the pages describe, read and quoted. */

const TEAMS = `# Teams and what they run

## Payments team

The Payments team runs the Northwind Pay gateway for every team that takes card payments. Reach it in the #payments channel.

## Ledger team

The Ledger team owns the ledger service and the month-end close project. It uses the Northwind Pay gateway and Harbour MFT.

## Vendors

Northwind Pay is the card processor; its contract is managed by the Payments team.
`;

const ANSWER = `items:
  - kind: team
    id: payments-team
    title: Payments team
    responsibilities: [Runs the Northwind Pay gateway for every team that takes card payments]
    owns: [Northwind Pay gateway]
    channel: "#payments"
    source: { page: teams.md, section: Payments team, quote: "The Payments team runs the Northwind Pay gateway for every team that takes card payments." }
  - kind: team
    id: ledger-team
    title: Ledger team
    owns: [ledger service, month-end close]
    uses: [Northwind Pay gateway, Harbour MFT]
    source: { page: teams.md, section: Ledger team, quote: "It uses the Northwind Pay gateway and Harbour MFT." }
  - kind: vendor
    id: northwind-pay
    title: Northwind Pay
    description: The card processor.
    owned_by: Payments team
    source: { page: teams.md, section: Vendors, quote: "Northwind Pay is the card processor; its contract is managed by the Payments team." }
  - kind: product
    id: northwind-pay-gateway
    title: Northwind Pay gateway
    owned_by: Payments team
    used_by: [Ledger team]
    vendor: Northwind Pay
    source: { page: teams.md, section: Payments team, quote: "The Payments team runs the Northwind Pay gateway for every team that takes card payments." }
  - kind: project
    id: month-end-close
    title: Month-end close
    owned_by: Ledger team
    source: { page: teams.md, section: Ledger team, quote: "The Ledger team owns the ledger service and the month-end close project." }
`;

async function scanned() {
  const base = await mkdtemp(join(tmpdir(), "atticus-parties-"));
  const wiki = join(base, "wiki");
  await mkdir(wiki, { recursive: true });
  await writeFile(join(wiki, "teams.md"), TEAMS);
  const root = join(base, "meta");
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack", "sources.yaml"),
    `schemaVersion: 1\nwikis:\n  - { id: org, type: markdown-folder, location: ${JSON.stringify(wiki.split("\\").join("/"))} }\n`,
  );
  const op = await loadOrgPack(join(root, "org-pack"));
  const now = "2026-10-20T09:00:00Z";
  const s = await syncSources({ root, orgPack: op, orgPackDir: join(root, "org-pack"), now });
  await writeSnapshots({ root, orgPack: op, sync: s, takenAt: now });
  const snap = (await readSnapshot(root, "org"))!;
  const r = await scanKnowledge([snap], {
    runtime: new MockRuntime(() => ANSWER),
    now: new Date(now),
  });
  await writeKnowledge(root, r, now, { snapshots: [snap] });
  return { root, r };
}

describe("teams, vendors, products and projects", () => {
  it("are read as Parties and Products, each quoted on its page", async () => {
    const { root, r } = await scanned();
    expect(r.failed).toEqual([]);
    const k = await readKnowledge(root);
    const byId = new Map(k.items.map((i) => [i.id, i]));
    expect(byId.get("ledger-team")).toMatchObject({
      kind: "Party",
      partyKind: "internal-team",
      name: "Ledger team",
      owns: ["ledger service", "month-end close"],
      uses: ["Northwind Pay gateway", "Harbour MFT"],
    });
    expect(byId.get("payments-team")).toMatchObject({ channel: "#payments" });
    expect(byId.get("northwind-pay")).toMatchObject({
      kind: "Party",
      partyKind: "vendor",
      owner: "Payments team",
    });
    expect(byId.get("northwind-pay-gateway")).toMatchObject({
      kind: "Product",
      productKind: "product",
      ownedBy: "Payments team",
      usedBy: ["Ledger team"],
      vendor: "Northwind Pay",
    });
    expect(byId.get("month-end-close")).toMatchObject({ kind: "Product", productKind: "project" });
    expect(k.items.map((i) => knowledgeKindOf(i)).sort()).toEqual([
      "product",
      "project",
      "team",
      "team",
      "vendor",
    ]);
    expect(itemTitle(byId.get("ledger-team")!)).toBe("Ledger team");
    expect(filterItems(k.items, { kind: "team" }).map((i) => i.id)).toEqual([
      "ledger-team",
      "payments-team",
    ]);
  });

  it("can be corrected by a person: a team's channel, a product's owner", async () => {
    const { root } = await scanned();
    const team = (await readKnowledge(root)).items.find((i) => i.id === "ledger-team")!;
    const r = reviewItem(team, {
      verdict: "corrected",
      by: "Tom George",
      at: "2026-10-21T10:00:00Z",
      set: { channel: "#ledger-help", uses: ["Northwind Pay gateway"] },
    });
    expect("error" in r).toBe(false);
    if (!("error" in r))
      expect(r.item).toMatchObject({ channel: "#ledger-help", uses: ["Northwind Pay gateway"] });
  });
});
