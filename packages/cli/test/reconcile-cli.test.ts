import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { main } from "../src/main.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

/** A metarepo with the Forge org pack, the expected catalog as files, and the diagram. */
async function forgeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-cli-rec-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  await cp(join(FORGE, "inputs/diagrams"), join(root, "inputs/diagrams"), { recursive: true });
  for (const r of parse(readFileSync(join(FORGE, "expected/scan.yaml"), "utf8")) as Record<
    string,
    unknown
  >[]) {
    const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
    if (!p.ok) throw new Error(String(r.id));
    const f = join(root, "catalog/generated", recordPath(p.record));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, serializeRecord(p.record));
  }
  return root;
}

describe("atticus reconcile", () => {
  it("lists what the diagram and the code disagree on, and exits 1", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(
      await main(["reconcile", "inputs/diagrams/forge-context.drawio", "--root", root], c.io),
    ).toBe(1);
    const text = c.out.join("\n");
    expect(text).toMatch(
      /inputs\/diagrams\/forge-context\.drawio: 7 edges, 5 matched to code, 7 items/,
    );
    expect(text).toMatch(
      /pattern-mismatch .*S\.GW\.VND goes through the gateway, the code calls directly/,
    );
    expect(text).toMatch(/alias-needed .*Ledger Platform/);
    expect(text).toMatch(/→ Confirm "Ledger Platform" is ledger-api/);
  });

  it("reads every diagram under inputs/diagrams by default, and prints JSON", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await main(["reconcile", "--json", "--root", root], c.io)).toBe(1);
    const res = JSON.parse(c.out.join("\n")) as {
      diagrams: { file: string; items: { type: string }[] }[];
    };
    expect(res.diagrams.map((d) => d.file)).toEqual(["inputs/diagrams/forge-context.drawio"]);
    expect(res.diagrams[0]!.items).toHaveLength(7);
  });

  it("exits 2 when there is no diagram to read", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-cli-rec-empty-"));
    const c = capture();
    expect(await main(["reconcile", "--root", root], c.io)).toBe(2);
    expect(c.err.join("\n")).toMatch(/No diagrams/);
    expect(await main(["reconcile", "missing.drawio", "--root", root], capture().io)).toBe(2);
  });
});

describe("atticus alias", () => {
  it("records a person's alias decision in catalog/curated, after which reconcile stops asking", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(
      await main(
        [
          "alias",
          "Ledger Platform",
          "ledger-api",
          "--by",
          "a.architect",
          "--reason",
          "Architects' name for the ledger service",
          "--root",
          root,
        ],
        c.io,
      ),
    ).toBe(0);
    expect(c.out[0]).toMatch(/catalog\/curated\/curateddecision\/alias\.ledger-platform\.yaml/);
    const text = readFileSync(
      join(root, "catalog/curated/curateddecision/alias.ledger-platform.yaml"),
      "utf8",
    );
    expect(parse(text)).toMatchObject({
      kind: "CuratedDecision",
      action: "alias",
      target: "ledger-api",
      value: "Ledger Platform",
      by: "a.architect",
      confidence: "asserted",
    });

    const r = capture();
    await main(["reconcile", "--json", "--root", root], r.io);
    const items = (JSON.parse(r.out.join("\n")) as { diagrams: { items: { type: string }[] }[] })
      .diagrams[0]!.items;
    expect(items.some((i) => i.type === "alias-needed")).toBe(false);
  });

  it("refuses an id that isn't in the catalog", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await main(["alias", "Ledger Platform", "ledger-apx", "--root", root], c.io)).toBe(1);
    expect(c.err.join("\n")).toMatch(/ledger-apx isn't in the catalog/);
    expect(await main(["alias", "Only a name", "--root", root], capture().io)).toBe(2);
  });
});
