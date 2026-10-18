import { readFileSync } from "node:fs";
import { cp, mkdtemp, appendFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { applyCurated, parseRecord, type CatalogRecord } from "@maycombhq/core";
import { buildTriage, scanInputs } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEF = join(HERE, "fixtures/defences");
const ORG = join(HERE, "fixtures/mixed/metarepo");
const RED_TEAM = join(HERE, "../../ai/test/fixtures/red-team");
const expected = parse(readFileSync(join(DEF, "expected.yaml"), "utf8")) as {
  documents: unknown[];
  records: Record<string, unknown>[];
  triage: unknown[];
  problems: unknown[];
};
const rec = (r: Record<string, unknown>): CatalogRecord => {
  const p = parseRecord({ schemaVersion: 1, status: "current", ...r });
  if (!p.ok) throw new Error(`${String(r.id)}: ${JSON.stringify(p.issues)}`);
  return p.record;
};
const opts = { root: ORG, inputsDir: join(DEF, "inputs"), scannedAt: "2026-10-18T09:00:00Z" };
const ITEM = "defences.doc-ledger-handover.ec8e7b90";

describe("intake screens what it takes in (golden: fixtures/defences)", () => {
  it("flags medium and high risk documents and says nothing about clean ones", async () => {
    const res = await scanInputs(opts);
    expect(res.problems).toEqual(expected.problems);
    expect(res.documents).toEqual(expected.documents);
    expect(res.records).toEqual(expected.records.map(rec));
  });

  it("raises one triage item for the high-risk file, with a decision for each answer", async () => {
    const res = await scanInputs(opts);
    expect(res.triage).toEqual(expected.triage);
  });

  it("is the same every time", async () => {
    expect(await scanInputs(opts)).toEqual(await scanInputs(opts));
  });

  it("puts the item in the triage list and a person's answer closes it", async () => {
    const inputs = await scanInputs(opts);
    const triage = buildTriage({ records: [], inputs });
    expect(triage.items.map((i) => i.id)).toEqual([ITEM]);
    const clear = triage.decide(ITEM, 0, { by: "a.architect", at: "2026-10-18T10:00:00Z" });
    expect(clear).toMatchObject({ target: "doc.ledger-handover", action: "suppress" });
    expect(buildTriage({ records: [], inputs, decisions: [clear] }).items).toEqual([]);
  });
});

describe("what a person decided", () => {
  const decide = async (optionIndex: number) => {
    const inputs = await scanInputs(opts);
    return buildTriage({ records: [], inputs }).decide(ITEM, optionIndex, {
      by: "a.architect",
      at: "2026-10-18T10:00:00Z",
    });
  };

  it("clearing the file removes the item and the high flag, and keeps the answer on record", async () => {
    const res = await scanInputs({ ...opts, records: [await decide(0)] });
    expect(res.triage).toEqual([]);
    expect(res.documents.find((d) => d.id === "doc.ledger-handover")?.defences?.risk).toBe(
      "cleared",
    );
    expect(res.records.find((r) => r.id === "doc.ledger-handover")).toMatchObject({
      flags: ["defences:cleared"],
    });
  });

  it("keeping it quarantined removes the item and keeps the file flagged high", async () => {
    const keep = await decide(1);
    const res = await scanInputs({ ...opts, records: [keep] });
    expect(res.triage).toEqual([]);
    const doc = res.records.find((r) => r.id === "doc.ledger-handover")!;
    expect(doc).toMatchObject({ flags: ["defences:high", "defences:quarantined"] });
    // the decision is applied to the record the same way
    expect(
      applyCurated(res.records, [keep]).records.find((r) => r.id === "doc.ledger-handover"),
    ).toMatchObject({ flags: ["defences:high", "defences:quarantined"] });
  });

  it("a clear answer holds only for the bytes that were cleared", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-defences-"));
    await cp(join(DEF, "inputs"), join(root, "inputs"), { recursive: true });
    const here = { root: ORG, inputsDir: join(root, "inputs") };
    const clear = await decide(0);
    expect((await scanInputs({ ...here, records: [clear] })).triage).toEqual([]);
    await appendFile(join(root, "inputs/inbox/ledger-handover.md"), "\nOne more line.\n");
    const again = await scanInputs({ ...here, records: [clear] });
    expect(again.triage).toHaveLength(1);
    expect(again.triage[0]!.id).not.toBe(ITEM);
  });
});

describe("red-team files from the ai package, dropped into inputs/", () => {
  const dropped = async (files: Record<string, string>) => {
    const root = await mkdtemp(join(tmpdir(), "atticus-redteam-"));
    for (const [to, from] of Object.entries(files)) {
      await mkdir(dirname(join(root, "inputs", to)), { recursive: true });
      await cp(join(RED_TEAM, from), join(root, "inputs", to));
    }
    return scanInputs({ root: ORG, inputsDir: join(root, "inputs") });
  };
  const risk = (res: Awaited<ReturnType<typeof scanInputs>>, path: string) =>
    res.documents.find((d) => d.path === path)?.defences?.risk;

  it("screens text formats by their kind", async () => {
    const res = await dropped({
      "wiki.md": "markdown/wiki-hidden-comment.md",
      "note.md": "markdown/visible-note.md",
      "ok.md": "markdown/benign-runbook.md",
      "page.html": "html/white-on-white.html",
      "pay.yaml": "openapi/base64-example.yaml",
      "escape.json": "openapi/unicode-escape.json",
      "label.drawio": "diagram/hidden-label.drawio",
      "report.txt": "pdf/extracted.txt",
    });
    expect(risk(res, "inputs/wiki.md")).toBe("high");
    expect(risk(res, "inputs/note.md")).toBe("medium");
    expect(risk(res, "inputs/ok.md")).toBeUndefined();
    expect(risk(res, "inputs/page.html")).toBe("high");
    expect(risk(res, "inputs/pay.yaml")).toBe("high");
    expect(risk(res, "inputs/escape.json")).toBe("high");
    expect(risk(res, "inputs/label.drawio")).toBe("high");
    expect(risk(res, "inputs/report.txt")).toBe("high");
    expect(res.triage.filter((t) => t.kind === "defences")).toHaveLength(6);
  });

  it("reads a Word file's hidden runs through the document's own parts", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-docx-"));
    await mkdir(join(root, "inputs"), { recursive: true });
    const xml = readFileSync(join(RED_TEAM, "docx/white-run.xml"), "utf8");
    await writeFile(
      join(root, "inputs/spec.docx"),
      storedZip({
        "[Content_Types].xml":
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        "word/document.xml": xml,
      }),
    );
    const res = await scanInputs({ root: ORG, inputsDir: join(root, "inputs") });
    expect(res.problems).toEqual([]);
    expect(risk(res, "inputs/spec.docx")).toBe("high");
    expect(res.records.find((r) => r.kind === "SourceDocument")).toMatchObject({
      flags: ["defences:high"],
    });
  });

  it("leaves images and other binary files alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-bin-"));
    await mkdir(join(root, "inputs"), { recursive: true });
    await writeFile(join(root, "inputs/blob.dat"), Uint8Array.from([0, 1, 2, 3, 0, 255, 0]));
    const res = await scanInputs({ root: ORG, inputsDir: join(root, "inputs") });
    expect(res.problems).toEqual([]);
    expect(res.documents[0]!.defences).toBeUndefined();
  });
});

/** A minimal ZIP with stored (uncompressed) entries, enough for the Office readers. */
function storedZip(files: Record<string, string>): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const n = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}
