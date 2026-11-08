import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readDocument } from "../src/documents.js";
import { writeZip } from "./helpers/zip-writer.js";

/**
 * Round 37: an 820-byte workbook naming row 4,000,000 or column ZZZZ used to fill every blank
 * between, until the reader (and the index build and the app behind it) hung.
 */
const FIX = join(import.meta.dirname, "fixtures/documents/inventory-xlsx");
const sheet = (rows: string) =>
  `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
const book = (rows: string) =>
  writeZip([
    { name: "[Content_Types].xml", data: readFileSync(join(FIX, "[Content_Types].xml")) },
    {
      name: "xl/workbook.xml",
      data: '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    { name: "xl/worksheets/sheet1.xml", data: sheet(rows) },
  ]);
const cell = (r: string, v: string) => `<c r="${r}" t="inlineStr"><is><t>${v}</t></is></c>`;

it("reads a far-off row and column at once, without their blanks, and skips past Excel's limits", () => {
  const started = Date.now();
  const r = readDocument(
    "far.xlsx",
    book(
      `<row r="1">${cell("A1", "first")}${cell("ZZZZ1", "wide")}</row>` +
        `<row r="1000000">${cell("A1000000", "far")}</row>` +
        `<row r="2000000000">${cell("A2000000000", "past")}</row>`,
    ),
  );
  expect(Date.now() - started).toBeLessThan(3000);
  const text = r.text!.sections.map((s) => s.text).join("\n");
  expect(text).toContain("first");
  expect(text).toContain("far");
  expect(text).not.toContain("past");
  expect(r.text!.tables![0]!.length).toBeLessThan(2000);
  expect(r.notes.join(" ")).toContain("past Excel's last row");
});
