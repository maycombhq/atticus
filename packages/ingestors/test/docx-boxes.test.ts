import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readDocument } from "../src/documents.js";
import { writeZip } from "./helpers/zip-writer.js";

/**
 * Review round 28: a Word text box (a callout or a shape's label) comes as a choice and its
 * fallback, and a tracked move keeps the old place; each is read once.
 */
const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures/documents/transfers-docx");
const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"';
const box = (t: string) =>
  `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:txbxContent></wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r>`;

function docx(body: string): Uint8Array {
  return writeZip([
    { name: "[Content_Types].xml", data: readFileSync(join(FIX, "[Content_Types].xml"), "utf8") },
    { name: "word/styles.xml", data: readFileSync(join(FIX, "word/styles.xml"), "utf8") },
    {
      name: "word/document.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    },
  ]);
}

describe("Word text boxes and tracked moves", () => {
  it("reads a text box once, not its fallback too", () => {
    const r = readDocument(
      "design.docx",
      docx(
        `<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r>${box("Gateway calls Ledger")}</w:p>`,
      ),
    );
    const text = r.text.sections.map((s) => s.text).join(" ");
    expect(text).toContain("Gateway calls Ledger");
    expect(text.match(/Gateway calls Ledger/g)).toHaveLength(1);
  });

  it("reads moved text where it is now, not where it was", () => {
    const r = readDocument(
      "design.docx",
      docx(
        `<w:p><w:moveFrom w:id="1"><w:r><w:t>Retry three times.</w:t></w:r></w:moveFrom><w:r><w:t>First.</w:t></w:r></w:p>` +
          `<w:p><w:moveTo w:id="2"><w:r><w:t>Retry three times.</w:t></w:r></w:moveTo></w:p>`,
      ),
    );
    const text = r.text.sections.map((s) => s.text).join(" ");
    expect(text.match(/Retry three times\./g)).toHaveLength(1);
    expect(text).toContain("First.");
  });
});
