import { describe, expect, it } from "vitest";
import { parseFactsLines } from "../src/index.js";

/** Review round 25B: facts written from PowerShell on Windows (a BOM; UTF-16). */
const fact = JSON.stringify({
  kind: "entry",
  id: "e1",
  repo: "forge-ledger",
  commit: "abc1234",
  entryType: "rest",
  method: "GET",
  path: "/v1/limits",
  cite: { file: "src/Limits.java", line: 3, value: "/v1/limits" },
});

describe("a facts file written on Windows", () => {
  it("keeps the first fact behind a UTF-8 byte-order mark", () => {
    const r = parseFactsLines(`\uFEFF${fact}\n`);
    expect(r.bad).toEqual([]);
    expect(r.facts.map((f) => f.id)).toEqual(["e1"]);
  });

  it("says a UTF-16 file is one, rather than not JSON", () => {
    const utf16 = Buffer.from(`${fact}\n`, "utf16le").toString("utf8");
    const r = parseFactsLines(utf16);
    expect(r.bad[0]!.issues[0]!.message).toMatch(/the file is UTF-16/);
  });
});
