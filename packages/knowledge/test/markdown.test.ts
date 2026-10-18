import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readMarkdown, sentences } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(HERE, "fixtures/markdown", name), "utf8");

describe("the Markdown section reader", () => {
  it("reads front matter, headings, paragraphs, lists, tables and code (golden)", () => {
    const doc = readMarkdown(fixture("page.md"));
    expect(doc).toEqual(parse(fixture("page.expected.yaml")));
  });

  it("puts text before the first heading in an untitled section and falls back to the first heading for a title", () => {
    const doc = readMarkdown("Lead text.\n\n# Real title\n\nBody.\n");
    expect(doc.title).toBe("Real title");
    expect(doc.sections.map((s) => [s.heading, s.level, s.line])).toEqual([
      ["", 0, 1],
      ["Real title", 1, 3],
    ]);
  });

  it("reports broken front matter instead of failing, and keeps line numbers right", () => {
    const doc = readMarkdown("---\ntitle: [unclosed\n---\n# Page\n\nText.\n");
    expect(doc.frontMatter).toEqual({});
    expect(doc.frontMatterProblem).toMatch(/front matter/);
    expect(doc.sections[0]).toMatchObject({ heading: "Page", line: 4 });
    expect(doc.sections[0]!.blocks[0]).toEqual({ type: "paragraph", line: 6, text: "Text." });
  });

  it("handles Windows line endings", () => {
    const doc = readMarkdown("# Page\r\n\r\nOne.\r\nTwo.\r\n");
    expect(doc.sections[0]!.blocks).toEqual([{ type: "paragraph", line: 3, text: "One.\nTwo." }]);
  });
});

describe("sentences", () => {
  it("splits paragraphs and list items into sentences with the line each starts on", () => {
    const doc = readMarkdown(
      "# P\n\nService level: 99.9% monthly availability. Peak load: 200 requests\nper second.\n\n- One item. Two.\n",
    );
    expect(sentences(doc)).toEqual([
      { text: "Service level: 99.9% monthly availability.", line: 3, section: "P" },
      { text: "Peak load: 200 requests per second.", line: 3, section: "P" },
      { text: "One item.", line: 6, section: "P" },
      { text: "Two.", line: 6, section: "P" },
    ]);
  });

  it("skips code blocks and tables", () => {
    const doc = readMarkdown("# P\n\n```\nNot. Prose.\n```\n\n| A |\n| - |\n| b. c |\n");
    expect(sentences(doc)).toEqual([]);
  });
});
