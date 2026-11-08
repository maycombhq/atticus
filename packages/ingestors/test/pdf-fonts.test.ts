import { describe, expect, it } from "vitest";
import { readDocument } from "../src/documents.js";
import { parseToUnicode } from "../src/pdf.js";

/**
 * Review round 28: browsers' Save as PDF, Confluence's export and iText write Type0 fonts, whose
 * strings are glyph ids. Read through the font's ToUnicode map; with no map, said, never guessed.
 */
const CMAP = `/CIDInit /ProcSet findresource begin
begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar
<002B> <0048>
<0048> <0065>
endbfchar
1 beginbfrange
<004F> <0052> [<006C> <0070> <0071> <006F>]
endbfrange
endcmap`;

function pdf(o: { toUnicode: boolean; show: string }): Uint8Array {
  const objs: string[] = [];
  const add = (body: string) => objs.push(body);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 5 0 R >> >> >>");
  add("<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>");
  const content = `BT /F1 12 Tf 72 700 Td ${o.show} Tj ET`;
  add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  add(
    `<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Calibri /Encoding /Identity-H${o.toUnicode ? " /ToUnicode 6 0 R" : ""} >>`,
  );
  add(`<< /Length ${CMAP.length} >>\nstream\n${CMAP}\nendstream`);
  const text =
    "%PDF-1.7\n" +
    objs.map((b, i) => `${i + 1} 0 obj ${b} endobj\n`).join("") +
    "trailer << /Root 1 0 R >>\n%%EOF\n";
  return new Uint8Array(Buffer.from(text, "latin1"));
}

describe("a PDF in a Type0 font", () => {
  it("reads the glyph ids through the font's ToUnicode map", () => {
    // H e l l o: 002B 0048 004F 004F 0052 (004F → l, 0052 → o by the range's array)
    const r = readDocument("guide.pdf", pdf({ toUnicode: true, show: "<002B0048004F004F0052>" }));
    expect(r.text.sections.map((s) => s.text).join(" ")).toContain("Hello");
    expect(r.notes).toEqual([]);
  });

  it("gives no text for a font with no map, and says a person needs to read it", () => {
    const r = readDocument("guide.pdf", pdf({ toUnicode: false, show: "<002B0048004F004F0052>" }));
    expect(r.text.sections.map((s) => s.text).join(" ")).not.toMatch(/\+HROOR|HROOR/);
    expect(r.notes.join(" ")).toMatch(/1 page of this PDF use a font with no map to letters/);
    expect(JSON.stringify(r.record)).toContain("needs-reading");
  });

  it("parses a CMap's chars and ranges", () => {
    const t = parseToUnicode(CMAP);
    expect(t.bytes).toBe(2);
    expect([0x2b, 0x48, 0x4f, 0x52].map((c) => t.map.get(c))).toEqual(["H", "e", "l", "o"]);
    const range = parseToUnicode(
      "begincodespacerange <00> <FF> endcodespacerange beginbfrange <41> <43> <0061> endbfrange",
    );
    expect(range.bytes).toBe(1);
    expect([0x41, 0x42, 0x43].map((c) => range.map.get(c))).toEqual(["a", "b", "c"]);
  });
});
