import {
  combine,
  formatOf,
  screenDiagramXml,
  screenOfficeXml,
  screenText,
  type Screening,
} from "@maycombhq/ai";
import { officeFormat, readDocument, readZip } from "@maycombhq/ingestors";

/**
 * Screens one dropped file with the ingested-content defences (ADR 0042, `@maycombhq/ai`).
 * Intake reads the file's own text where it has it: plain-text formats as UTF-8; Word and
 * PowerPoint files part by part (hidden runs are found in the XML); PDF and Excel through the
 * document ingestor's extracted text. Images and other binary files carry no text to screen.
 * Pure and offline: nothing here is followed, run or sent anywhere.
 */
export interface FileScreen {
  /** Undefined when the file has no text to screen (an image, a binary file). */
  screening?: Screening;
  /** Why a file that has text could not be screened; becomes an intake problem. */
  problem?: string;
}

const PK = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;
const PDF = (b: Uint8Array) =>
  new TextDecoder("latin1").decode(b.subarray(0, 1024)).includes("%PDF-");

/** Text of a document as the ingestor extracted it. */
function extracted(path: string, bytes: Uint8Array): string {
  const read = readDocument(path, bytes);
  return [
    read.text.title,
    ...read.text.sections.flatMap((s) => [s.heading, s.text]),
    ...(read.text.tables ?? []).flatMap((t) => t.map((row) => row.join(" | "))),
  ]
    .filter((s) => s)
    .join("\n");
}

export function screenFile(path: string, bytes: Uint8Array): FileScreen {
  if (bytes.length === 0) return {};
  try {
    if (PK(bytes)) {
      const office = officeFormat(bytes.subarray(0, 4096));
      if (!office || office === "vsdx") return {};
      const zip = readZip(bytes);
      const parts = zip.names
        .filter((n) =>
          office === "docx"
            ? /^word\/[^/]+\.xml$/.test(n)
            : office === "pptx"
              ? /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(n)
              : false,
        )
        .sort();
      return {
        screening: combine(
          ...parts.map((n) => screenOfficeXml(zip.text(n) ?? "")),
          screenText(extracted(path, bytes), { format: "office" }),
        ),
      };
    }
    if (PDF(bytes)) return { screening: screenText(extracted(path, bytes), { format: "pdf" }) };
    // Any other file with a NUL byte near the start is binary (images, archives, .dat).
    if (bytes.subarray(0, 8192).includes(0)) return {};
    const text = new TextDecoder().decode(bytes);
    if (/\.(drawio|xml)$/i.test(path) && /<mxfile|<mxGraphModel/.test(text.slice(0, 4096)))
      return { screening: screenDiagramXml(text) };
    return { screening: screenText(text, { format: formatOf("document", path) }) };
  } catch (e) {
    return {
      problem: `could not be read to screen it for hidden instructions: ${(e as Error).message}`,
    };
  }
}
