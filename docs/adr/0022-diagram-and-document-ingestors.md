# 0022. Diagram and document ingestors

- Status: accepted
- Date: 2026-10-18

## Decision

`@maycombhq/ingestors` reads Lucidchart CSV exports, Visio `.vsdx` files and Mermaid flowcharts (whole files or fenced blocks in Markdown) into the same `Diagram` model as draw.io (ADR 0019), with the same label grammar: pattern code, then `METHOD /path` or a topic, plus a legend. Reconcile is therefore format-agnostic, and `atticus reconcile` reads every one of these formats (`readDiagram`).

Documents (Markdown with front matter, HTML, plain text, `.docx`, `.pptx`, `.xlsx`, PDF) become a plain-text `TextDocument` of sections and tables. Ingested text is data, never instructions: nothing inside it is followed, opened or run, and links (Mermaid `click`, Figma links) are kept as text, never opened. Images and Figma files are recorded only: an image gets a `needs-reading` flag, and edges read from it later are asserted only after a person confirms each one.

Every C4 ingestor yields only a `SourceDocument` (`doc.<file stem>`, evidence `diagram` or `document`). Facts turn into records through reconcile or intake triage, never straight from an ingestor.

Office and Visio files are opened with an in-house ZIP reader (no dependency): central directory, stored and deflate entries, per-entry and total size caps that also stop lying headers and zip bombs, an entry-count cap, no `..`, absolute or drive paths, no encrypted or ZIP64 entries, and CRC checks. PDF reading is best effort (Flate and uncompressed streams, object streams, page order, text operators) and says when it finds no text; it never guesses.

## Consequences

The Forge diagram redrawn in Lucid, Mermaid and Visio gives exactly the draw.io edges, and the same reconcile items. Scanned or encrypted PDFs and custom font encodings without a ToUnicode map yield no text and go to a person. The label helpers are duplicated in `ingestors/src/labels.ts` until reconcile exports its own; candidate additive C1 field: `SourceDocument.title`.
