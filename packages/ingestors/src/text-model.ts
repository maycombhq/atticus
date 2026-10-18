import type { DocumentMeta } from "./record.js";

/** One part of a document under a heading. Level 0 is text before any heading (or a title). */
export interface TextSection {
  heading: string;
  level: number;
  text: string;
  /** Line of the heading in the source file, for text formats. */
  line?: number;
  /** Page (PDF), slide (.pptx) or sheet (.xlsx) number, from 1. */
  page?: number;
}

/**
 * A document as plain text: data for intake to read, never instructions. Nothing inside it
 * is followed, run or interpreted by the readers.
 */
export interface TextDocument {
  title: string;
  sections: TextSection[];
  /** Tables as rows of cells, in document order. */
  tables?: string[][][];
}

/** What a format reader returns before the title and record are settled. */
export interface ParsedText {
  title?: string;
  sections: TextSection[];
  tables: string[][][];
  meta: DocumentMeta;
  notes: string[];
}

/** Thrown by a reader when a file is not what its name says; becomes a note, not a crash. */
export class ReadError extends Error {
  override name = "ReadError";
}

/** Section builder shared by the readers: text lines go to the current section. */
export class Sections {
  readonly list: TextSection[] = [];
  private lines: string[] = [];
  private cur: TextSection = { heading: "", level: 0, text: "" };
  private firstLine?: number;

  heading(heading: string, level: number, at: { line?: number; page?: number } = {}) {
    this.flush();
    this.cur = { heading, level, text: "", ...at };
  }

  /** Add a line of text; `line` is where it is in the file (an untitled section starts there). */
  add(text: string, line?: number) {
    if (this.firstLine === undefined && line !== undefined && text.trim()) this.firstLine = line;
    this.lines.push(text);
  }

  /** Take back the last line added (Markdown: a setext underline turns it into a heading). */
  popLine(): string | undefined {
    return this.lines.pop();
  }

  /** Close the current section. One with neither heading nor text is dropped. */
  flush() {
    const text = trimBlankLines(this.lines);
    const untitled = this.cur.heading === "";
    if (!(untitled && !text)) {
      const line = this.cur.line ?? (untitled ? this.firstLine : undefined);
      this.list.push({ ...this.cur, text, ...(line !== undefined ? { line } : {}) });
    }
    this.lines = [];
    this.firstLine = undefined;
  }

  done(): TextSection[] {
    this.flush();
    return this.list;
  }
}

/** Lines joined with "\n", trailing spaces dropped, blank lines at either end removed. */
export function trimBlankLines(lines: string[]): string {
  const l = lines.map((x) => x.replace(/\s+$/, ""));
  while (l.length && !l[0]) l.shift();
  while (l.length && !l.at(-1)) l.pop();
  return l.join("\n");
}
