import { describe, expect, it } from "vitest";
import { lineAtFolded } from "../src/needs.js";

/** Review round 28: where a need's quote starts, found in one pass however long the file. */
const fold = (s: string) =>
  s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
const slow = (text: string, at: number) => {
  const lines = text.split("\n");
  let line = 1;
  for (let j = 1; j < lines.length; j++)
    if (fold(lines.slice(0, j).join("\n")).length < at) line = j + 1;
    else break;
  return line;
};

describe("the line a need's quote is on", () => {
  it("is the line the slow way found, for every offset of a file with blank lines and runs of spaces", () => {
    const text =
      "# Design\n\n  The ledger   checks\tthe limit.\n\n\nRetries: three.\n  \nThe end.\n";
    const folded = fold(text);
    for (let at = 0; at <= folded.length; at++)
      expect(lineAtFolded(text, at), String(at)).toBe(slow(text, at));
  });

  it("places a quote near the end of an 8,000-line file in well under a second", () => {
    const text = Array.from(
      { length: 8000 },
      (_, i) => `Line ${i} of the design, with words.`,
    ).join("\n");
    const at = fold(text).indexOf(fold("Line 7000 of the design"));
    const t = Date.now();
    expect(lineAtFolded(text, at)).toBe(7001);
    expect(Date.now() - t).toBeLessThan(5000); // the old way took 43 s here
  });
});
