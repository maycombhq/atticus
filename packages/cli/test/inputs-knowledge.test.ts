import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  loadOrgPack,
  orgPackDirOf,
  parseRecord,
  recordPath,
  serializeRecord,
} from "@maycombhq/core";
import { inputsPages } from "../src/inputs-knowledge.js";
import { main } from "../src/main.js";

/**
 * General knowledge dropped in the metarepo's inputs/ (ADR 0122): a source of its own, always
 * on. Each document is read into text; intake's dedupe and versions decide which copy counts;
 * what isn't read says why. Invented Forge files only.
 */

const ADR = `# Decision: the ledger owns transfer limits

The Forge Ledger service owns every transfer limit. Forge Pay asks the ledger before it moves money.
`;

const RUNBOOK = `Forge Pay runbook

When Northwind Pay times out, Forge Pay retries twice, then parks the transfer for a person.
`;

async function metarepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-inputs-knowledge-"));
  await mkdir(join(root, "org-pack"), { recursive: true });
  await writeFile(
    join(root, "org-pack", "runtime.yaml"),
    "schemaVersion: 1\nassistants: { allowed: [copilot], default: copilot }\n",
  );
  const inputs = join(root, "inputs");
  await mkdir(join(inputs, "decisions"), { recursive: true });
  await mkdir(join(inputs, "inbox"), { recursive: true });
  await writeFile(join(inputs, "decisions", "ledger-owns-limits.md"), ADR);
  await writeFile(join(inputs, "forge-pay-runbook-v1.txt"), "Forge Pay runbook\n\nOld text.\n");
  await writeFile(join(inputs, "forge-pay-runbook-v2.txt"), RUNBOOK);
  // The same bytes dropped twice: the copy outside the inbox counts.
  await writeFile(join(inputs, "inbox", "ledger-owns-limits.md"), ADR);
  // A picture: a person reads it (the text-only rule), so it is listed, not read.
  await writeFile(join(inputs, "whiteboard.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]));
  return root;
}

describe("knowledge files in inputs/ (ADR 0122)", () => {
  it("reads each document once, the newest version, and says why the rest aren't read", async () => {
    const root = await metarepo();
    const op = await loadOrgPack(orgPackDirOf(root));
    const r = await inputsPages(root, op);
    expect(r.pages.map((p) => [p.pagePath, p.path])).toEqual([
      ["decisions/ledger-owns-limits.md", "inputs/decisions/ledger-owns-limits.md"],
      ["forge-pay-runbook-v2.txt", "inputs/forge-pay-runbook-v2.txt"],
    ]);
    // Markdown is kept as it is, so a quote's line is the file's line.
    expect(r.pages[0]!.content).toBe(ADR);
    expect(r.pages[1]!.content).toContain("Forge Pay retries twice");
    const why = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
    expect(why["inputs/inbox/ledger-owns-limits.md"]).toMatch(
      /same file as inputs\/decisions\/ledger-owns-limits\.md/,
    );
    expect(why["inputs/forge-pay-runbook-v1.txt"]).toMatch(
      /older version.*inputs\/forge-pay-runbook-v2\.txt/,
    );
    expect(why["inputs/whiteboard.png"]).toMatch(/picture/);
    expect(r.skipped.every((s) => s.source === "inputs")).toBe(true);
  });

  it("sources sync snapshots inputs/ with no wiki configured, and the knowledge scan finds it", async () => {
    const root = await metarepo();
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      ["sources", "sync", "--source", "inputs", "--json", "--root", root],
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      { quiet: true },
    );
    expect(err.join("\n")).not.toMatch(/No wikis/);
    expect([0, 1]).toContain(code);
    const j = JSON.parse(out.join("\n")) as { snapshots: { source: string; dir: string }[] };
    const snap = j.snapshots.find((s) => s.source === "inputs");
    expect(snap).toBeDefined();
    const manifest = parse(
      await readFile(join(root, ...snap!.dir.split("/"), "snapshot.yaml"), "utf8"),
    ) as { pages: { page: string }[]; skipped: { page: string; reason: string }[] };
    expect(manifest.pages.map((p) => p.page)).toEqual([
      "decisions/ledger-owns-limits.md",
      "forge-pay-runbook-v2.txt",
    ]);
    expect(manifest.skipped.map((s) => s.page)).toEqual(
      expect.arrayContaining(["inputs/whiteboard.png", "inputs/forge-pay-runbook-v1.txt"]),
    );
  });
});

describe("the Documents tab's list (ADR 0122 item 2)", () => {
  it("says for each file whether it was read, why not, and which items quote it", async () => {
    const { listDocuments } = await import("../src/documents.js");
    const root = await metarepo();
    expect((await listDocuments(root)).snapshot).toBeNull();
    const before = (await listDocuments(root)).documents;
    expect(before.every((d) => d.state === "not-synced")).toBe(true);

    await main(
      ["sources", "sync", "--source", "inputs", "--root", root],
      { out: () => {}, err: () => {} },
      { quiet: true },
    );
    const snapDate = new Date().toISOString().slice(0, 10);
    // An item the knowledge scan would write, quoting the decision's snapshot copy.
    const item = parseRecord({
      schemaVersion: 2,
      kind: "Pattern",
      id: "ledger-owns-limits",
      code: "ledger-owns-limits",
      name: "The ledger owns transfer limits",
      patternKind: "standard",
      patternStatus: "to-review",
      rules: ["The Forge Ledger service owns every transfer limit."],
      status: "current",
      confidence: "inferred",
      evidence: [
        {
          source: "document",
          path: `knowledge/snapshots/inputs/${snapDate}/decisions/ledger-owns-limits.md`,
          line: 3,
        },
      ],
      quote: {
        source: "inputs",
        page: "decisions/ledger-owns-limits.md",
        section: "Decision: the ledger owns transfer limits",
        text: "The Forge Ledger service owns every transfer limit.",
        snapshot: snapDate,
      },
    });
    if (!item.ok) throw new Error(JSON.stringify(item.issues));
    const f = join(root, "knowledge", "items", ...recordPath(item.record).split("/"));
    await mkdir(join(f, ".."), { recursive: true });
    await writeFile(f, serializeRecord(item.record));

    const l = await listDocuments(root);
    expect(l.snapshot).toEqual({ date: snapDate });
    const by = Object.fromEntries(l.documents.map((d) => [d.path, d]));
    expect(by["inputs/decisions/ledger-owns-limits.md"]).toMatchObject({
      state: "read",
      kind: "document",
      inbox: false,
      items: [
        { id: "ledger-owns-limits", title: "The ledger owns transfer limits", verified: false },
      ],
    });
    expect(by["inputs/inbox/ledger-owns-limits.md"]).toMatchObject({
      state: "skipped",
      inbox: true,
      duplicateOf: "inputs/decisions/ledger-owns-limits.md",
    });
    expect(by["inputs/forge-pay-runbook-v1.txt"]).toMatchObject({
      state: "skipped",
      supersededBy: "inputs/forge-pay-runbook-v2.txt",
    });
    expect(by["inputs/whiteboard.png"]!.reason).toMatch(/picture/);
    expect(l.commands).toContain("atticus knowledge scan --source inputs");
  });
});
