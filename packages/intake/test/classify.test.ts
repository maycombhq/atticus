import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { classify, payloadFields } from "../src/index.js";

const text = (s: string) => new TextEncoder().encode(s);

/** A minimal zip holding the named (empty) entries, enough to tell Office files apart. */
function zip(names: string[]): Uint8Array {
  const parts: number[] = [];
  const central: number[] = [];
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n: number) => [...u16(n & 0xffff), ...u16(n >>> 16)];
  for (const n of names) {
    const name = [...text(n)];
    const body = [...deflateRawSync(Buffer.alloc(0))];
    const offset = parts.length;
    parts.push(0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(8), ...u32(0), ...u32(0));
    parts.push(...u32(body.length), ...u32(0), ...u16(name.length), ...u16(0), ...name, ...body);
    central.push(0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(8));
    central.push(...u32(0), ...u32(0), ...u32(body.length), ...u32(0), ...u16(name.length));
    central.push(...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name);
  }
  return new Uint8Array([...parts, ...central]);
}

describe("classify", () => {
  it.each([
    [
      "spec.yaml",
      "openapi: 3.0.3\ninfo:\n  title: Contoso Ledger\n  version: '1'\npaths: {}\n",
      "openapi",
    ],
    ["spec.yml", "openapi: 3.0\npaths: {}\n", "openapi"],
    ["x.json", '{"swagger":"2.0","info":{"title":"T"},"paths":{}}', "swagger"],
    ["x.yaml", "swagger: 2.0\npaths: {}\n", "swagger"],
    ["events.yaml", "asyncapi: 3.0.0\nchannels: {}\n", "asyncapi"],
    ["notes", "# A heading\n", "document"],
    ["page.html", "<!DOCTYPE html><html></html>", "document"],
    ["drawing.xml", '<?xml version="1.0"?>\n<mxfile host="drawio"></mxfile>', "diagram"],
    ["logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>', "image"],
    ["sample.xml", "<refund><id>1</id></refund>", "payload"],
    ["list.json", '[{"id": 1, "type": "Bug", "title": "Broken"}]', "ticket-export"],
    ["list.json", '[{"amount": 1}]', "payload"],
    ["config.yaml", "server:\n  port: 8080\n", "unknown"],
    ["broken.json", "{ nope", "unknown"],
    ["table.tsv", "a\tb\n", "spreadsheet"],
  ])("%s is %s… → %s", (name, body, want) => {
    expect(classify(name, text(body)).classification).toBe(want);
  });

  it("reads specs' title and version", () => {
    expect(
      classify("a.yaml", text("openapi: 3.1.0\ninfo:\n  title: Fabrikam FX\n  version: 2.1.0\n")),
    ).toMatchObject({ classification: "openapi", title: "Fabrikam FX", version: "2.1.0" });
  });

  it("tells binary formats apart by their content, not their names", () => {
    expect(classify("x.bin", new Uint8Array([0xff, 0xd8, 0xff, 0xe0])).classification).toBe(
      "image",
    );
    expect(classify("x.bin", text("%PDF-1.7\n")).classification).toBe("document");
    expect(
      classify("a.zip", zip(["[Content_Types].xml", "word/document.xml"])).classification,
    ).toBe("document");
    expect(classify("a.zip", zip(["xl/workbook.xml"])).classification).toBe("spreadsheet");
    expect(classify("a.zip", zip(["visio/document.xml"])).classification).toBe("diagram");
    expect(classify("a.lucid", zip(["document.json"])).classification).toBe("diagram");
    expect(classify("a.zip", zip(["readme.txt"])).classification).toBe("unknown");
    expect(classify("x.dat", new Uint8Array([0, 1, 2, 0xff])).classification).toBe("unknown");
  });
});

describe("payloadFields", () => {
  it("keeps names and types and never a value", () => {
    const fields = payloadFields({ a: { b: [{ c: 1 }, { d: "x" }] }, e: [] });
    expect(fields).toEqual([
      { name: "a", type: "object" },
      { name: "a.b", type: "array" },
      { name: "a.b[]", type: "object" },
      { name: "a.b[].c", type: "number" },
      { name: "a.b[].d", type: "string" },
      { name: "e", type: "array" },
    ]);
    expect(JSON.stringify(fields)).not.toMatch(/"x"|1/);
  });
});
