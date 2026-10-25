import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseRecord, recordPath, serializeRecord } from "@maycombhq/core";
import { intakeAdd, intakeList, triageDecide, triageList } from "../src/intake-commands.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");
const MIXED = join(dirname(fileURLToPath(import.meta.url)), "../../intake/test/fixtures/mixed");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

/** A metarepo with the Forge org pack, the expected catalog as files, and the Forge inputs. */
async function forgeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atticus-cli-intake-"));
  await cp(join(FORGE, "metarepo/org-pack"), join(root, "org-pack"), { recursive: true });
  // the fixture's wiki location points outside the metarepo; inside one it is inputs/wiki
  await writeFile(
    join(root, "org-pack/sources.yaml"),
    "schemaVersion: 1\nwikis:\n  - { id: forge-wiki, type: markdown-folder, location: inputs/wiki }\n",
  );
  await cp(join(FORGE, "inputs"), join(root, "inputs"), { recursive: true });
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

describe("atticus intake add", () => {
  it("copies files into inputs/inbox and says what each one is", async () => {
    const root = await forgeRoot();
    const c = capture();
    const code = await intakeAdd(
      root,
      [
        join(MIXED, "inputs/inbox/northwind-swagger.json"),
        join(MIXED, "inputs/inbox/meeting-notes.md"),
      ],
      c.io,
    );
    expect(code).toBe(0);
    expect(c.out).toEqual([
      "Added inputs/inbox/northwind-swagger.json (swagger).",
      "Added inputs/inbox/meeting-notes.md (document, needs reading).",
      "Run atticus intake list to see what Atticus made of them.",
      // B2: a document becomes knowledge through the inputs source (ADR 0122), not intake list.
      "To read the documents into knowledge every change can use: atticus sources sync --source inputs, then atticus knowledge scan --source inputs.",
    ]);
    expect((await readdir(join(root, "inputs/inbox"))).sort()).toEqual([
      "meeting-notes.md",
      "northwind-swagger.json",
    ]);
  });

  it("refuses a file that is already in inputs, and keeps a different file with the same name", async () => {
    const root = await forgeRoot();
    const other = await mkdtemp(join(tmpdir(), "atticus-cli-intake-src-"));
    await writeFile(join(other, "northwind-pay-openapi.yaml"), "openapi: 3.0.3\npaths: {}\n");
    const c = capture();
    const code = await intakeAdd(
      root,
      [
        join(FORGE, "inputs/partner-specs/northwind-pay-openapi.yaml"),
        join(other, "northwind-pay-openapi.yaml"),
        join(other, "northwind-pay-openapi.yaml"),
        join(other, "missing.yaml"),
      ],
      c.io,
    );
    expect(code).toBe(1);
    expect(c.err).toEqual([
      `${join(FORGE, "inputs/partner-specs/northwind-pay-openapi.yaml")} is already in inputs as inputs/partner-specs/northwind-pay-openapi.yaml; not copied.`,
      `${join(other, "northwind-pay-openapi.yaml")} is already in inputs as inputs/inbox/northwind-pay-openapi.yaml; not copied.`,
      `Can't read ${join(other, "missing.yaml")}.`,
    ]);
    expect(c.out[0]).toBe("Added inputs/inbox/northwind-pay-openapi.yaml (openapi).");
    expect(await intakeAdd(root, [], capture().io)).toBe(2);
  });
});

describe("atticus intake list", () => {
  it("lists every input with its type, status and systems", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await intakeList(root, c.io, {})).toBe(0);
    expect(c.out).toEqual([
      "PATH                                             TYPE           STATUS     SYSTEMS",
      "inputs/diagrams/forge-context.drawio             diagram        read       ledger, northwind-pay, portal, reports",
      "inputs/partner-specs/northwind-pay-openapi.yaml  openapi        read       northwind-pay",
      "inputs/tickets/ado-stories.json                  ticket-export  no-reader",
      "inputs/tickets/closed-service-requests.json      ticket-export  no-reader",
      "4 files: 2 read, 2 with no reader yet.",
    ]);
  });

  it("shows duplicates and version chains, and prints JSON", async () => {
    const root = await forgeRoot();
    await cp(join(MIXED, "inputs/partner-specs"), join(root, "inputs/partner-specs"), {
      recursive: true,
    });
    await cp(
      join(MIXED, "inputs/inbox/copy-of-fx-v2.yaml"),
      join(root, "inputs/inbox/copy-of-fx-v2.yaml"),
    );
    const c = capture();
    expect(await intakeList(root, c.io, {})).toBe(0);
    const text = c.out.join("\n");
    expect(text).toMatch(
      /inputs\/inbox\/copy-of-fx-v2\.yaml +openapi +duplicate of inputs\/partner-specs\/fabrikam-fx-openapi-v2\.yaml/,
    );
    expect(text).toMatch(
      /Versions:\n {2}inputs\/partner-specs\/fabrikam-fx-openapi-v1\.yaml → inputs\/partner-specs\/fabrikam-fx-openapi-v2\.yaml/,
    );
    const j = capture();
    await intakeList(root, j.io, { json: true });
    const res = JSON.parse(j.out.join("\n")) as {
      documents: { path: string; status: string }[];
      chains: string[][];
      problems: unknown[];
    };
    expect(res.chains).toEqual([
      [
        "inputs/partner-specs/fabrikam-fx-openapi-v1.yaml",
        "inputs/partner-specs/fabrikam-fx-openapi-v2.yaml",
      ],
    ]);
    expect(res.documents).toHaveLength(8);
    expect(res.problems).toEqual([]);
  });

  it("says how to start when inputs/ is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-cli-intake-empty-"));
    const c = capture();
    expect(await intakeList(root, c.io, {})).toBe(0);
    expect(c.out).toEqual([
      "Nothing in inputs/ yet: drop files into inputs/inbox/, or run atticus intake add <files>.",
    ]);
  });
});

describe("atticus triage", () => {
  it("lists what a person must decide, with numbered options, and exits 1", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await triageList(root, c.io, {})).toBe(1);
    const text = c.out.join("\n");
    expect(c.out[0]).toBe("7 items to decide.");
    expect(text).toMatch(
      /alias-needed\.ledger-platform \(alias-needed\)\n {2}The diagram's "Ledger Platform" was matched to ledger-api/,
    );
    expect(text).toMatch(/ {2}at inputs\/diagrams\/forge-context\.drawio:9 \(cell ledger\)/);
    expect(text).toMatch(/ {2}1\. "Ledger Platform" is ledger-api\n {2}2\. Dismiss/);
    expect(text).toMatch(/ {2}→ Did you mean S\.GW\.SOR\?/);
    expect(c.out.at(-1)).toBe("Decide one with: atticus triage decide <item> <option>");

    const j = capture();
    await triageList(root, j.io, { json: true });
    const items = (JSON.parse(j.out.join("\n")) as { items: { id: string }[] }).items;
    expect(items.map((i) => i.id)).toContain("planned.e7");
  });

  it("writes the decision under catalog/curated, after which the item is gone", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(
      await triageDecide(
        root,
        "alias-needed.ledger-platform",
        1,
        { by: "a.architect", reason: "The architects' name for the ledger service" },
        c.io,
      ),
    ).toBe(0);
    expect(c.out).toEqual([
      'Wrote catalog/curated/curateddecision/alias.ledger-platform.yaml: "Ledger Platform" is ledger-api. Commit it so everyone\'s triage uses it.',
    ]);
    const saved = parse(
      readFileSync(
        join(root, "catalog/curated/curateddecision/alias.ledger-platform.yaml"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(saved).toMatchObject({
      kind: "CuratedDecision",
      action: "alias",
      target: "ledger-api",
      value: "Ledger Platform",
      by: "a.architect",
      reason: "The architects' name for the ledger service",
    });
    const after = capture();
    await triageList(root, after.io, { json: true });
    const ids = (JSON.parse(after.out.join("\n")) as { items: { id: string }[] }).items.map(
      (i) => i.id,
    );
    expect(ids).not.toContain("alias-needed.ledger-platform");
    expect(ids).toHaveLength(6);
  });

  it("refuses an unknown item (exit 1) or a bad option (exit 2)", async () => {
    const root = await forgeRoot();
    const c = capture();
    expect(await triageDecide(root, "nope", 1, { by: "x" }, c.io)).toBe(1);
    expect(c.err).toEqual(["There is no open triage item nope. List them with: atticus triage"]);
    const b = capture();
    expect(await triageDecide(root, "planned.e7", 3, { by: "x" }, b.io)).toBe(2);
    expect(b.err).toEqual(["planned.e7 has 1 option; pick 1 to 1."]);
    expect(await triageDecide(root, "planned.e7", 0, { by: "x" }, capture().io)).toBe(2);
  });

  it("says so when there is nothing to decide", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-cli-triage-empty-"));
    const c = capture();
    expect(await triageList(root, c.io, {})).toBe(0);
    expect(c.out).toEqual(["Nothing to triage."]);
  });
});
